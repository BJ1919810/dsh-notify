/**
 * Verify the click path without DSH, without a toast, and without a restart.
 *
 * Three checks, each entering the chain one level earlier than the last:
 *
 *   1. activate.ps1 <uri>            — the PowerShell handler posts the id back
 *   2. cscript activate.vbs <uri>    — the VBS launch + its URI sanitizer
 *   3. cmd /c start "" <uri>         — Windows resolves the registered scheme
 *
 * Check 3 is the same ShellExecute a toast click performs, so it covers the
 * registry entry too. What it does not cover: the browser half that consumes the
 * id (`GET /pending` → `ctx.uiWorkspace.openSession`), which needs the GUI.
 *
 * The receiver is started in this process on the configured port; nothing here
 * shows a notification, and the only visible side effect is that a successful
 * activation asks Windows to bring the DSH window forward.
 *
 *   node scripts/verify-activation.mjs
 *   node scripts/verify-activation.mjs --scheme dshnotify --port 5178
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ActivationServer, activationUri } from '../lib/activation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CSCRIPT = 'C:\\Windows\\System32\\cscript.exe';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const scheme = option('scheme', 'dshnotify');
const port = Number(option('port', '5178'));

const server = new ActivationServer({ port, scheme });
const started = await server.start();
if (!started.ok) {
  console.error(`FAIL: receiver did not start — ${started.reason}`);
  console.error(
    'The handler posts to the port in assets\\activation.json, so this check needs that port for\n' +
      'itself: quit DSH first (it holds the same port while activation is enabled), or re-run\n' +
      'scripts/install-activation.ps1 -Port <other> and pass the same --port here.',
  );
  process.exit(2);
}
console.log(`receiver: 127.0.0.1:${started.port}`);

let failures = 0;

/** Run one command to completion. */
function run(command, argv) {
  return new Promise(resolveRun => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk.toString('utf8')));
    child.stderr.on('data', chunk => (output += chunk.toString('utf8')));
    child.once('close', code => resolveRun({ code, output: output.trim() }));
  });
}

/** Read the endpoint until an id appears or the budget runs out. */
async function waitForPending(budgetMs = 4000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const pending = await (await fetch(`http://127.0.0.1:${started.port}/pending`)).json();
    if (pending !== null) return pending;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return null;
}

/** Drain whatever an earlier check left behind. */
async function drain() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pending = await (await fetch(`http://127.0.0.1:${started.port}/pending`)).json();
    if (pending === null) return;
  }
}

async function check(name, runIt, expectation = { deliver: true }) {
  await drain();
  const id = `session-verify-${name.replace(/[^a-z0-9]+/gi, '-')}`;
  const result = await runIt(`dshnotify:${id}`.replace('dshnotify:', `${scheme}:`));
  const pending = await waitForPending();
  const delivered = pending?.sessionId === id;
  const ok = result.code === 0 && delivered === expectation.deliver;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} exit=${result.code} delivered=${delivered}` +
      (result.output === '' ? '' : `\n      output: ${result.output.split('\n')[0]}`),
  );
  return { ok, id };
}

await check('powershell', uri => run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'assets', 'activate.ps1'), uri]));
await check('vbs', uri => run(CSCRIPT, ['//nologo', join(root, 'assets', 'activate.vbs'), uri]));
await check('windows-shell', uri => run('cmd.exe', ['/c', 'start', '', uri]));

// Negative control: the VBS drops anything outside the session-id alphabet, so a
// forged URI must never reach the receiver. A check that only ever sees PASS is
// not evidence that the sanitizer exists.
await check('vbs-forged', uri => run(CSCRIPT, ['//nologo', join(root, 'assets', 'activate.vbs'), `${uri}" & calc.exe & "`]), {
  deliver: false,
});

await server.stop();

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed (the browser half is exercised by clicking a real notification)');
