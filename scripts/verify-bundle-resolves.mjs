/**
 * Prove a profile can resolve and import a bundle by package name.
 *
 * Listing a name in `dsh.profile.bundles` is a promise that the loader can
 * import it. This checks that promise the way Node itself would — from the
 * profile directory — because "the row is in the list" and "the package
 * resolves" are two different facts, and getting only the first one is what
 * made a boot fail.
 *
 *   node scripts/verify-bundle-resolves.mjs --profile <dir> --name dsh-notify
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const profileDir = resolve(typeof args.profile === 'string' ? args.profile : '.');
const names = typeof args.name === 'string' && args.name !== ''
  ? [args.name]
  : JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? [];

let failed = 0;
const require = createRequire(join(profileDir, 'package.json'));

for (const name of names) {
  // The `@deepseek-ai/dsh-base` style names are shipped inside the harness
  // itself, so only the profile's own packages are expected to resolve here.
  if (name.startsWith('@deepseek-ai/')) {
    process.stdout.write(`skip  ${name} (ships with the harness)\n`);
    continue;
  }
  let entry;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch (error) {
    process.stdout.write(`FAIL  ${name}: not resolvable from the profile — ${error.message.split('\n')[0]}\n`);
    failed += 1;
    continue;
  }
  if (!existsSync(entry)) {
    process.stdout.write(`FAIL  ${name}: resolved to a path that does not exist (${entry})\n`);
    failed += 1;
    continue;
  }
  const manifest = JSON.parse(readFileSync(entry, 'utf8'));
  let importer;
  try {
    const mod = await import(pathToFileURL(join(entry, '..', manifest.main ?? 'index.js')).href);
    importer = `exports ${Object.keys(mod).sort().join(', ')}`;
  } catch (error) {
    process.stdout.write(`FAIL  ${name}: resolved but cannot import — ${error.message.split('\n')[0]}\n`);
    failed += 1;
    continue;
  }
  const hasBundle = manifest.dsh?.bundle !== undefined;
  process.stdout.write(
    `ok    ${name} -> ${entry}\n` +
      `      ${importer}\n` +
      `      dsh.bundle: ${hasBundle ? 'declared' : 'MISSING (it will not insert its entry)'}\n`,
  );
  if (!hasBundle) failed += 1;
}

process.stdout.write(`\n${failed === 0 ? 'all listed bundles resolve' : `${failed} problem(s)`}\n`);
process.exit(failed === 0 ? 0 : 1);
