/**
 * Make the two peer dependencies resolvable for development.
 *
 * A DSH plugin is loaded *by the host*, which already has `@deepseek-ai/cordis`
 * and `@deepseek-ai/schemastery` in memory — that is what the peer range in
 * package.json means. Outside the host there is nothing to resolve them from,
 * and they are published as `access: restricted`, so `npm install` could not
 * fetch them here either.
 *
 * This points `node_modules/<peer>` at the copy the running profile actually
 * uses, which is also the version the tests should be run against. Junctions do
 * not need elevation on Windows; a symlink would.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packages this project needs to resolve outside the host.
 *
 * `@deepseek-ai/cordis` is deliberately absent: the plugin never imports it
 * (Cordis hands a plugin its context; nothing is imported from the framework),
 * so it is declared as a peer only because the host is the thing that loads
 * this plugin. Only the imports present in `lib/` need to resolve for a test
 * run, and those are `schemastery` plus its own runtime dependency `cosmokit`.
 */
const PEERS = ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit'];

/** A peer that cannot be found is fatal only when the plugin imports it. */
const REQUIRED = new Set(['@deepseek-ai/schemastery']);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');

/**
 * Where the running DSH profile keeps its packages.
 *
 * `DSH_HOME` / `DSH_PROFILE` are set by the host that launches a session, but a
 * terminal started by other means often has neither — so the user's home
 * directory, which is where DSH installs by default, is the fallback rather
 * than the exception. `DSH_NOTIFY_PEER_ROOT` is the escape hatch for a
 * checkout or a non-standard layout.
 */
function peerRoots(env = process.env) {
  const roots = [];
  const override = env.DSH_NOTIFY_PEER_ROOT;
  if (typeof override === 'string' && override !== '') roots.push(resolve(override));

  const homes = [];
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') homes.push(env.DSH_HOME);
  for (const key of ['HOME', 'USERPROFILE']) {
    const home = env[key];
    if (typeof home === 'string' && home !== '') homes.push(join(home, '.dsh'));
  }

  const profiles = [];
  if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE !== '') profiles.push(env.DSH_PROFILE);
  profiles.push('desktop', 'web');

  for (const dshHome of homes) {
    // Every found profile is a candidate so that a machine running more than
    // one has a chance of resolving, but the running one is checked first.
    const ordered = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE !== ''
      ? [env.DSH_PROFILE, ...profiles.filter(name => name !== env.DSH_PROFILE)]
      : profiles;
    for (const profile of ordered) roots.push(join(dshHome, 'profiles', profile, 'node_modules'));
  }
  return roots;
}

function findPeer(peer, roots, exists = existsSync) {
  for (const rootCandidate of roots) {
    const candidate = join(rootCandidate, peer);
    if (exists(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

const roots = peerRoots();
const linked = [];
const missing = [];

for (const peer of PEERS) {
  const source = findPeer(peer, roots);
  const target = join(nodeModules, peer);
  if (source === undefined) {
    missing.push(peer);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  // A stale link would be worse than none: it would silently test against a
  // profile that is no longer the one running.
  rmSync(target, { recursive: true, force: true });
  symlinkSync(source, target, 'junction');
  linked.push(`${peer} → ${source}`);
}

for (const line of linked) process.stdout.write(`linked ${line}\n`);
if (missing.length > 0) {
  const fatal = missing.filter(peer => REQUIRED.has(peer));
  process.stdout.write(
    `not found in any profile: ${missing.join(', ')}\n` +
      'Set DSH_NOTIFY_PEER_ROOT to a node_modules directory that contains them.\n',
  );
  if (fatal.length > 0) process.exitCode = 1;
}
