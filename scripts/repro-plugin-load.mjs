/**
 * Reproduce a plugin's load-time failure outside the host.
 *
 * A plugin that throws while loading takes the whole DSH boot down (the boot is
 * all-or-nothing), so the useful thing to do is find out which property access
 * is illegal — without asking the user to restart. Cordis's Context is a Proxy
 * that throws `cannot get property "X" without inject` for anything not in the
 * plugin's `inject` list, so a minimal Proxy with the same behaviour reproduces
 * the failure exactly.
 *
 *   node scripts/repro-plugin-load.mjs --module <path-to-plugin-lib-index.js>
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

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
if (typeof args.module !== 'string') {
  process.stderr.write('usage: node scripts/repro-plugin-load.mjs --module <plugin lib/index.js>\n');
  process.exit(2);
}

const target = resolve(args.module);
const mod = await import(pathToFileURL(target).href);
console.log(`module:   ${target}`);
console.log(`name:     ${mod.name ?? '(not exported)'}`);
console.log(`inject:   ${JSON.stringify(mod.inject ?? null)}`);
console.log(`has Config: ${mod.Config !== undefined}`);
console.log('');

// Cordis's rule, reduced to its essence: reading a property the plugin never
// asked for throws. Everything Cordis itself provides on every context is
// allowed; `optional` is how a plugin asks for something it can do without.
const declared = new Set(
  Array.isArray(mod.inject)
    ? mod.inject
    : [
        ...(mod.inject?.required ?? []),
        ...(mod.inject?.optional ?? []),
      ],
);
const alwaysAvailable = new Set(['get', 'on', 'effect', 'inject', 'logger', 'scope', 'fiber', 'reflect', 'events']);

const violations = [];
function guard(label) {
  // A real Cordis context answers `get`/`on`/`logger` and the rest of the
  // framework surface; only *services* go through the inject rule. The overlay
  // below supplies those, so they must not be treated as violations.
  const overlay = new Map();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (overlay.has(prop)) return overlay.get(prop);
        if (alwaysAvailable.has(prop) || declared.has(prop)) return undefined;
        violations.push(`${label}.${String(prop)}`);
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
      // The probe has to be able to install its own stubs; a Cordis context is
      // not frozen either, so writes must not be mistaken for reads.
      set(_target, prop, value) {
        overlay.set(prop, value);
        return true;
      },
      has() {
        return true;
      },
    },
  );
}

// `get` mirrors the real service lookup, and is how a plugin is *supposed* to
// reach something it did not declare.
const ctx = guard('ctx');
ctx.get = () => undefined;
ctx.on = () => {};
ctx.effect = () => {};
ctx.inject = () => ({});
ctx.logger = { info() {}, warn() {}, error() {}, debug() {} };

let failure;
try {
  const result = mod.apply(ctx, {}, undefined);
  if (result instanceof Promise) await result;
} catch (error) {
  failure = error;
}

if (failure !== undefined) {
  console.log(`LOAD FAILED: ${failure.message}`);
  if (violations.length > 0) {
    console.log(`illegal accesses: ${[...new Set(violations)].join(', ')}`);
    console.log('');
    console.log('Fix: either read the value with ctx.get(...), or add the name to the');
    console.log('plugin\'s inject list. A service removed from the inject list is not');
    console.log('optional in Cordis — the access throws.');
  }
  process.exit(1);
}

console.log('LOAD OK (apply returned without throwing)');
