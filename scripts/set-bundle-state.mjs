/**
 * Enable or disable a bundle in a DSH profile.
 *
 * Two hard-won constraints shape this script, and both of them cost the user a
 * broken boot to learn:
 *
 * 1. **It must refuse to run against a live host.** The running DSH host
 *    rewrites the profile's `package.json` from its in-memory composition. An
 *    external edit looks like it worked — the file really does change — and is
 *    then silently reverted.
 * 2. **It must not depend on a PowerShell version.** The first version of this
 *    was a PowerShell script, developed and tested on Windows PowerShell 5.1.
 *    Run under PowerShell 7 its `ConvertFrom-Json`/`ConvertTo-Json` round trip
 *    produced a trailing comma, which is not valid JSON, so DSH refused to boot
 *    with `Unexpected token ', {'`. Node has one JSON implementation and it is
 *    the same one everywhere, so the edit happens here instead.
 *
 *   node scripts/set-bundle-state.mjs --name dsh-custom-instructions --action enable
 *   node scripts/set-bundle-state.mjs --name dsh-notify --action disable
 *
 * Node is located automatically; DSH ships one at
 * `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`, and
 * `scripts/set-bundle-state.cmd` wraps that for convenience.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ACTIONS = new Set(['enable', 'disable']);

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
const action = typeof args.action === 'string' ? args.action.trim() : '';
const profileDir = resolve(
  typeof args.profile === 'string' && args.profile !== ''
    ? args.profile
    : join(homedir(), '.dsh', 'profiles', 'desktop'),
);

if (name === '' || !ACTIONS.has(action)) {
  process.stderr.write(
    'usage: node scripts/set-bundle-state.mjs --name <bundle> --action enable|disable [--profile <dir>]\n',
  );
  process.exit(2);
}

// --- 1. a live host would undo this, so refuse ----------------------------
function hostPids() {
  try {
    // PowerShell is the only portable way to read command lines on Windows, and
    // this runs before anything is written, so a failure here is harmless.
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
    // If the probe itself is unavailable, do not block the user: the host
    // rewrite is recoverable, being unable to configure anything is not.
    process.stdout.write('warn  could not check for a running DSH (probe failed)\n');
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

// --- 2. read the profile --------------------------------------------------
const manifestPath = join(profileDir, 'package.json');
if (!existsSync(manifestPath)) {
  process.stderr.write(`not found: ${manifestPath}\n`);
  process.exit(2);
}

const original = readFileSync(manifestPath, 'utf8');
let profile;
try {
  profile = JSON.parse(original);
} catch (error) {
  process.stderr.write(
    `refusing to edit: ${manifestPath} is not valid JSON (${error.message}).\n` +
      'Fix or restore it first — editing on top of a broken file makes it worse.\n',
  );
  process.exit(1);
}

const bundles = profile?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  process.stderr.write('refusing to edit: package.json has no dsh.profile.bundles array\n');
  process.exit(2);
}

const enabled = bundles.includes(name);
if (enabled === (action === 'enable')) {
  process.stdout.write(`ok    "${name}" is already ${action}d; nothing to do\n`);
  process.exit(0);
}

// --- 3. rewrite, preserving the file's own formatting ---------------------
const newline = original.includes('\r\n') ? '\r\n' : '\n';
const indentMatch = original.match(/\n([ \t]+)"/);
const indent = indentMatch ? indentMatch[1] : '  ';
const trailingNewline = original.endsWith('\n');

const next = action === 'enable' ? [...bundles, name] : bundles.filter(entry => entry !== name);
profile.dsh.profile.bundles = next;

// `JSON.stringify` is the one implementation that is identical everywhere, and
// its output is valid JSON by construction — which is the whole point.
let text = JSON.stringify(profile, null, indent);
if (newline === '\r\n') text = text.replace(/\n/g, '\r\n');
if (trailingNewline) text += newline;

// A last self-check before touching the file: the bytes that are about to be
// written must parse back to what was intended. The previous PowerShell version
// skipped this and shipped a trailing comma.
try {
  const reparsed = JSON.parse(text);
  const reparsedBundles = reparsed.dsh.profile.bundles;
  if (JSON.stringify(reparsedBundles) !== JSON.stringify(next)) {
    throw new Error('reparsed bundles do not match the intended list');
  }
} catch (error) {
  process.stderr.write(`refusing to write: ${error.message}\n`);
  process.exit(1);
}

const backupPath = `${manifestPath}.bak-${name.replace(/[^A-Za-z0-9]/g, '_')}`;
copyFileSync(manifestPath, backupPath);
writeFileSync(manifestPath, text, 'utf8');

// --- 4. confirm what actually landed on disk -----------------------------
const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
const settled = written.dsh.profile.bundles;
if (settled.includes(name) !== (action === 'enable')) {
  process.stderr.write('the write did not take effect as expected\n');
  process.exit(1);
}

process.stdout.write(`ok    ${action}d "${name}"\n`);
process.stdout.write(JSON.stringify(settled, null, 2).split('\n').map(l => `  ${l}`).join('\n') + '\n');
process.stdout.write(`\nbackup: ${backupPath}\n`);
process.stdout.write('next:   start DSH — bundles are composed at boot, so this has no effect until then\n');
