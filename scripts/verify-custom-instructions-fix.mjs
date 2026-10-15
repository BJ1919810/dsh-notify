/**
 * Verify the dsh-custom-instructions fix outside the host.
 *
 * Two things have to be true at once, and only one of them is obvious:
 *
 *  1. Loading must not throw. That was the failure: a read of `ctx.config`,
 *     which is not a Cordis service — `config` is only
 *     `Symbol.for('cordis.config')` — so the Context Proxy threw, and because
 *     DSH's boot is all-or-nothing the whole harness failed to start.
 *  2. The registered section must still read the LIVE configuration. The
 *     original code went looking for `ctx.config` to avoid capturing the first
 *     config object, and dropping that read must not turn the section into a
 *     stale snapshot.
 *
 * (2) holds because the loader updates the configuration *in place*: it calls
 * cosmokit's `updateVolatile(target, source)`, which does `target[write](
 * source.get())` on the plugin's own stable reference. So an update keeps the
 * object identity the plugin closed over, and mutating that object — which is
 * what this probe does — is exactly what a settings write looks like from the
 * plugin's side. Replacing the object instead would be testing the wrong thing:
 * Cordis does not replace it.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modulePath = resolve(
  process.argv[2] ??
    'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\dsh-custom-instructions\\lib\\index.js',
);

const mod = await import(pathToFileURL(modulePath).href);

let registered;
const ctx = {
  // The one service this plugin declares.
  systemPrompt: {
    section(section) {
      registered = section;
    },
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
};

const live = { instructions: 'first instruction', enabled: true, wrapHeading: true };

let failed;
try {
  mod.apply(ctx, live);
} catch (error) {
  failed = error;
}

if (failed !== undefined) {
  console.log(`FAIL  apply threw: ${failed.message}`);
  process.exit(1);
}
console.log('ok    apply() completed without throwing');

if (registered === undefined) {
  console.log('FAIL  no section was registered');
  process.exit(1);
}
console.log(`ok    section registered: ${registered.name} (order ${registered.order})`);

const before = registered.text();
console.log(`ok    text() before a settings write: ${JSON.stringify(before.slice(-40))}`);

// A settings write mutates the same object in place, which is what
// updateVolatile does to the plugin's stable reference.
live.instructions = 'second instruction';
const after = registered.text();
console.log(`ok    text() after  a settings write: ${JSON.stringify(after.slice(-40))}`);

if (!after.includes('second instruction')) {
  console.log('FAIL  the section reads a stale config — a settings write is not visible');
  process.exit(1);
}
console.log('ok    the live configuration is read per assembly, not captured at load time');
