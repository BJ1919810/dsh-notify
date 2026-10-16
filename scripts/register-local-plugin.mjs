/**
 * Register a local plugin in a DSH profile the way the plugin list expects.
 *
 * Two things make a plugin "installed" in this profile, and they are read by
 * different parts of the system:
 *
 *   dsh.profile.bundles   → the loader composes it at boot (this is what runs it)
 *   dependencies          → the Settings → Plugins list shows it, with a toggle
 *
 * `set-bundle-state.mjs` writes the first one. A plugin that only has that row
 * does load and does work, but it never appears in the plugin list, so it cannot
 * be switched off from the UI — which is exactly the complaint this script
 * exists to fix. Every plugin in that list (dsh-context, dshmarket,
 * dsh-custom-instructions, …) has both.
 *
 *   node scripts/register-local-plugin.mjs --name dsh-notify \
 *        --dir C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-notify
 *
 * Refuses to run while DSH is up: a live host rewrites the profile's
 * package.json from memory, so the edit would look applied and then vanish.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const NODE = process.execPath;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[token.slice(2)] = true;
      continue;
    }
    args[token.slice(2)] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const name = typeof args.name === 'string' ? args.name.trim() : '';
const dir = typeof args.dir === 'string' ? resolve(args.dir) : '';
const profileDir = resolve(
  typeof args.profile === 'string' && args.profile !== ''
    ? args.profile
    : join(homedir(), '.dsh', 'profiles', 'desktop'),
);

if (name === '' || dir === '') {
  process.stderr.write(
    'usage: node scripts/register-local-plugin.mjs --name <package> --dir <plugin dir> [--profile <profile dir>]\n',
  );
  process.exit(2);
}
if (!existsSync(join(dir, 'package.json'))) {
  process.stderr.write(`refusing: ${dir} has no package.json\n`);
  process.exit(1);
}

/** Read text without a byte-order mark (a BOM breaks JSON.parse on import). */
function readText(path) {
  const raw = readFileSync(path, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

// --- 1. a live host would undo this --------------------------------------
function hostPids() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name LIKE 'DeepSeek Harness%'\" | " +
          "Where-Object { $_.CommandLine -like '*dsh*' } | Select-Object -ExpandProperty ProcessId",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    return out
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\d+$/.test(line));
  } catch {
    return [];
  }
}

const pids = process.platform === 'win32' ? hostPids() : [];
if (pids.length > 0 && process.env.DSH_NOTIFY_SKIP_HOST_CHECK !== '1') {
  process.stderr.write(
    `refusing to edit: DSH is running (pid ${pids.join(', ')}).\n` +
      'A live host rewrites the profile from memory, so this change would be reverted.\n' +
      'Quit DeepSeek Harness completely (not just the window) and run this again.\n',
  );
  process.exit(1);
}
process.stdout.write(
  pids.length > 0
    ? `warn  a DSH is running (pid ${pids.join(', ')}); host check skipped by request\n`
    : 'ok    no running DSH found\n',
);

// --- 2. add the dependency ------------------------------------------------
const manifestPath = join(profileDir, 'package.json');
const original = readText(manifestPath);
const profile = JSON.parse(original);
if (profile.dependencies === undefined || typeof profile.dependencies !== 'object') {
  process.stderr.write('refusing: profile package.json has no dependencies object\n');
  process.exit(1);
}
const bundles = profile?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  process.stderr.write('refusing: profile package.json has no dsh.profile.bundles array\n');
  process.exit(1);
}

// Forward slashes: npm and pnpm both accept them, and a Windows path with
// backslashes inside JSON needs escaping that is easy to get wrong.
const spec = `file:${dir.split('\\').join('/')}`;
const already = profile.dependencies[name];
if (already === spec) {
  process.stdout.write(`ok    dependencies.${name} already points at ${dir}\n`);
} else {
  profile.dependencies[name] = spec;
  process.stdout.write(`ok    dependencies.${name} = ${spec}${already ? ` (was ${already})` : ''}\n`);
}

if (!bundles.includes(name)) {
  process.stderr.write(
    `warning: "${name}" is not in dsh.profile.bundles. Adding the dependency makes it\n` +
      '         visible in the plugin list, but nothing will load it. Run\n' +
      `         set-bundle-state.mjs --name ${name} --action enable --link ${dir}\n` +
      '         as well if that is not already done.\n',
  );
}

const indentMatch = original.match(/\n([ \t]+)"/);
const indent = indentMatch ? indentMatch[1] : '  ';
let text = JSON.stringify(profile, null, indent);
text = original.includes('\r\n') ? `${text.replace(/\n/g, '\r\n')}\r\n` : `${text}\n`;

// Parse before writing: a hand-edited file is the usual reason this runs at all.
try {
  JSON.parse(text);
} catch (error) {
  process.stderr.write(`refusing to write invalid JSON: ${error.message}\n`);
  process.exit(1);
}

const backupPath = `${manifestPath}.bak-register-${name.replace(/[^A-Za-z0-9]/g, '_')}`;
copyFileSync(manifestPath, backupPath);
writeFileSync(manifestPath, text, { encoding: 'utf8' }); // no BOM
process.stdout.write(`ok    wrote profile package.json (backup: ${backupPath})\n`);

// --- 3. make node_modules match -------------------------------------------
// pnpm install is the real thing: it also keeps pnpm-lock.yaml in step, so a
// later install does not undo this. If it fails, the link is created directly —
// still correct for the loader, but the lockfile will not know about it.
const pnpm = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
const linkPath = join(profileDir, 'node_modules', name);
let linked = false;
if (existsSync(pnpm)) {
  process.stdout.write('note  running pnpm install (keeps the lockfile in step)…\n');
  const result = spawnSync(NODE, [pnpm, 'install', '--prefer-offline'], {
    cwd: profileDir,
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? join(homedir(), '.dsh') },
    timeout: 600000,
  });
  linked = result.status === 0;
  process.stdout.write(linked ? 'ok    pnpm install finished\n' : `warn  pnpm install exited ${result.status}\n`);
} else {
  process.stdout.write(`note  no bundled pnpm at ${pnpm}\n`);
}

if (!linked) {
  try {
    if (existsSync(linkPath)) {
      const st = lstatSync(linkPath);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        process.stderr.write(
          `refusing to replace ${linkPath}: it is a real directory, not a link.\n` +
            'Remove it yourself if it is stale, then run this again.\n',
        );
        process.exit(1);
      }
      rmSync(linkPath, { recursive: true, force: true });
    }
    symlinkSync(dir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    process.stdout.write(`ok    linked node_modules/${name} -> ${dir}\n`);
    process.stdout.write(
      'warn  the lockfile was NOT updated. The plugin works, but a later\n' +
        '      `pnpm install` in this profile can remove the link. If that happens,\n' +
        '      run this script again, or run pnpm there with DSH_HOME set.\n',
    );
  } catch (error) {
    process.stderr.write(`could not link node_modules/${name}: ${error.message}\n`);
    process.exit(1);
  }
}

// --- 4. confirm -----------------------------------------------------------
const written = JSON.parse(readText(manifestPath));
const okDependency = written.dependencies[name] === spec;
const okLink = existsSync(join(linkPath, 'package.json'));
process.stdout.write('\n');
process.stdout.write(`${okDependency ? 'ok   ' : 'FAIL '} dependencies.${name} is ${written.dependencies[name]}\n`);
process.stdout.write(`${okLink ? 'ok   ' : 'FAIL '} node_modules/${name} resolves\n`);
process.stdout.write(
  `\nnext: start DSH. "${name}" should now appear under Settings → Plugins ("已安装")\n` +
    '      with a toggle.\n',
);
process.exit(okDependency && okLink ? 0 : 1);
