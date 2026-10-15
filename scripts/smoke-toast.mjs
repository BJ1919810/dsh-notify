/**
 * Smoke tests that need the real machine.
 *
 * Two things cannot be tested in-process, and both are worth checking before a
 * release: that the Config schema actually builds against the `schemastery`
 * version the host is running (a schema that throws at module scope would take
 * the plugin — and, because DSH's boot is all-or-nothing, the host — down), and
 * that a toast really appears in the Windows notification area.
 *
 * Usage:
 *   node scripts/smoke-toast.mjs           # schema check, then one real toast
 *   node scripts/smoke-toast.mjs --schema  # schema check only
 */
import { showToast, transportAvailability } from '../lib/powershell-toast.js';
import { Config, normalize } from '../lib/index.js';

const schemaOnly = process.argv.includes('--schema');
let failed = false;

function report(label, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed = true;
}

// The schema is built at module scope, so reaching this line at all already
// means the import succeeded. What is worth asserting is that the schema the
// host will render accepts the values this plugin expects and rejects the ones
// it does not — schemastery validates by throwing rather than by falling back,
// so a typo in a hand-edited profile surfaces as a load error, which is the
// behaviour the Config descriptions promise.
const throws = fn => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

try {
  const defaults = Config({});
  const settings = normalize(defaults);
  report(
    'Config builds and applies defaults',
    settings.notifyOn === 'every-turn' && settings.settleDelayMs === 400 && settings.sound === 'kind',
    `notifyOn=${settings.notifyOn} settleDelayMs=${settings.settleDelayMs}`,
  );
  report('Config validates notifyOn', throws(() => Config({ notifyOn: 'sometimes' })));
  report('Config keeps a known sound', Config({ sound: 'Reminder' }).sound === 'Reminder');
  report('Config validates sound', throws(() => Config({ sound: 'Nope' })));
  report('Config validates the delay range', throws(() => Config({ settleDelayMs: -1 })));
  report('Config validates the delay maximum', throws(() => Config({ settleDelayMs: 10_000_000 })));
  // The value a hand-edited profile could contain: normalize is what turns it
  // back into something usable, because the schema never gets a chance to.
  report('normalize rescues an invalid value', normalize({ notifyOn: 'sometimes' }).notifyOn === 'every-turn');
} catch (error) {
  report('Config builds', false, error instanceof Error ? error.message : String(error));
}

if (!schemaOnly) {
  const availability = transportAvailability();
  report('windows toast transport is available', availability.ok, availability.reason ?? '');
  if (availability.ok) {
    const { pid, outcome } = showToast({
      title: '✅ dsh-notify 冒烟测试',
      body: `这是一条真实通知，进程 ${process.pid}。看到它就说明链路可用。`,
      sound: 'Default',
    });
    process.stdout.write(`     toast process: ${pid ?? 'n/a'}\n`);
    const result = await outcome;
    report('powershell reported the toast as shown', result.ok, result.reason ?? '');
    process.stdout.write('     (a toast should be visible in the notification area now)\n');
  }
}

process.exit(failed ? 1 : 0);
