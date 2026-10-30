/**
 * Tests for the activation bridge: the receiving end of a toast click.
 *
 * These talk to a real socket on an ephemeral port instead of stubbing HTTP:
 * the whole value of this module is that a `SetForegroundWindow`-less child
 * process can hand a session id across a process boundary, and a fake server
 * would not prove that a request ever arrives.
 *
 * Nothing here shows a toast, focuses a window, or touches the registry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActivationServer,
  PendingSession,
  activationUri,
  normalizeSessionId,
  sessionIdFromUri,
} from '../lib/activation.js';
import { SCRIPT_TEMPLATE, buildStdin } from '../lib/powershell-toast.js';
import { apply } from '../lib/index.js';

const SESSION_ID = 'session-6f1c2a4e-b39d-4f1a-9c2b-1d3e5f7a9b0c';

/** A listening server on a free port, plus the base URL to talk to it. */
async function startedServer(options = {}) {
  const server = new ActivationServer({ port: 0, ...options });
  const result = await server.start();
  assert.equal(result.ok, true, `server did not start: ${result.reason}`);
  const port = result.port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await server.stop();
    },
  };
}

test('a session id is only a session id', () => {
  assert.equal(normalizeSessionId(SESSION_ID), SESSION_ID);
  for (const bad of ['', ' leading space', 'has space', 'has/slash', 'a'.repeat(201), undefined, null, 42]) {
    assert.equal(normalizeSessionId(bad), undefined);
  }
});

test('the activation URI is the scheme and the id, and nothing that could be a command line', () => {
  assert.equal(activationUri('dshnotify', SESSION_ID), `dshnotify:${SESSION_ID}`);
  assert.equal(activationUri('DshNotify', SESSION_ID), `dshnotify:${SESSION_ID}`);
  // A quote, a space or a second argument would change the handler's command line.
  assert.equal(activationUri('dshnotify', 'x" & calc & "'), undefined);
  // Schemes that already mean something to Windows must not be stolen.
  for (const reserved of ['http', 'https', 'file', 'shell', 'dsh']) {
    assert.equal(activationUri(reserved, SESSION_ID), undefined);
  }
});

test('the URI round-trips back to the same session', () => {
  const uri = activationUri('dshnotify', SESSION_ID);
  assert.equal(sessionIdFromUri(uri, 'dshnotify'), SESSION_ID);
  assert.equal(sessionIdFromUri(`dshnotify:${SESSION_ID}`, 'other'), undefined);
  assert.equal(sessionIdFromUri(`other:${SESSION_ID}`, 'dshnotify'), undefined);
});

test('one pending click is handed out exactly once', () => {
  const pending = new PendingSession();
  assert.equal(pending.peek(), undefined);
  assert.equal(pending.remember(SESSION_ID), true);
  assert.deepEqual(pending.peek(), { sessionId: SESSION_ID, at: pending.peek().at });
  const taken = pending.take();
  assert.equal(taken.sessionId, SESSION_ID);
  assert.equal(pending.take(), undefined, 'a session must not open twice');
});

test('a stale click expires instead of opening an old conversation', () => {
  let now = 1_000;
  const pending = new PendingSession({ now: () => now, ttlMs: 500 });
  pending.remember(SESSION_ID, now);
  now += 499;
  assert.equal(pending.peek()?.sessionId, SESSION_ID);
  now += 2;
  assert.equal(pending.peek(), undefined);
});

test('a click survives one poll per second but is not sticky', async () => {
  const bridge = await startedServer();
  try {
    const activate = await fetch(`${bridge.base}/activate?s=${encodeURIComponent(SESSION_ID)}`, { method: 'POST' });
    assert.equal(activate.status, 204);
    const first = await (await fetch(`${bridge.base}/pending`)).json();
    assert.equal(first.sessionId, SESSION_ID);
    const second = await (await fetch(`${bridge.base}/pending`)).json();
    assert.equal(second, null);
  } finally {
    await bridge.close();
  }
});

test('a hidden surface can watch without taking the click', async () => {
  const bridge = await startedServer();
  try {
    await fetch(`${bridge.base}/activate?s=${encodeURIComponent(SESSION_ID)}`, { method: 'POST' });
    // A watcher must not be able to steal a click it cannot act on.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const peeked = await (await fetch(`${bridge.base}/pending?peek=1`)).json();
      assert.equal(peeked.sessionId, SESSION_ID);
    }
    const claimed = await (await fetch(`${bridge.base}/pending`)).json();
    assert.equal(claimed.sessionId, SESSION_ID, 'the consuming read still gets it');
    assert.equal(await (await fetch(`${bridge.base}/pending`)).json(), null);
  } finally {
    await bridge.close();
  }
});

test('an empty queue answers null rather than an error', async () => {
  const bridge = await startedServer();
  try {
    const response = await fetch(`${bridge.base}/pending`);
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
  } finally {
    await bridge.close();
  }
});

test('a forged activation with no usable id is refused', async () => {
  const bridge = await startedServer();
  try {
    for (const query of ['', '?s=', '?s=has%20space', '?s=' + 'a'.repeat(300)]) {
      const response = await fetch(`${bridge.base}/activate${query}`, { method: 'GET' });
      assert.equal(response.status, 400, `accepted ${query}`);
    }
    assert.equal((await (await fetch(`${bridge.base}/pending`)).json()), null);
  } finally {
    await bridge.close();
  }
});

test('the poll is a cross-origin request, so the answer carries CORS', async () => {
  const bridge = await startedServer();
  try {
    const response = await fetch(`${bridge.base}/pending`, { headers: { Origin: 'dsh-app://app' } });
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await bridge.close();
  }
});

test('unknown paths are 404, and the port is reported back', async () => {
  const bridge = await startedServer({ scheme: 'dshnotify' });
  try {
    assert.equal((await fetch(`${bridge.base}/nope`)).status, 404);
    const health = await (await fetch(`${bridge.base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.scheme, 'dshnotify');
    assert.equal(health.port, Number(new URL(bridge.base).port));
  } finally {
    await bridge.close();
  }
});

test('a taken port degrades to a reported failure, never a throw', async () => {
  const first = await startedServer();
  try {
    const port = Number(new URL(first.base).port);
    const second = new ActivationServer({ port });
    const result = await second.start();
    assert.equal(result.ok, false);
    assert.match(result.reason, /already in use/);
    await second.stop();
  } finally {
    await first.close();
  }
});

test('the toast carries the launch URI only when one was handed in', () => {
  const withLaunch = buildStdin({ appId: 'app-1', title: 't', body: 'b', launch: `dshnotify:${SESSION_ID}` });
  assert.match(withLaunch, new RegExp(`^launch=dshnotify:${SESSION_ID}$`, 'm'));
  const without = buildStdin({ appId: 'app-1', title: 't', body: 'b' });
  assert.doesNotMatch(without, /^launch=/m);
  // The template reads the field and falls back to the identity string, which is
  // what keeps an uninstalled handler from changing existing behaviour.
  assert.ok(SCRIPT_TEMPLATE.includes('launch="'), 'the toast must still declare a launch attribute');
  assert.ok(SCRIPT_TEMPLATE.includes('Escape($target)'), 'the launch target must be XML-escaped');
  assert.match(SCRIPT_TEMPLATE, /if \(\[string\]::IsNullOrEmpty\(\$launch\)\) \{ \$appId \} else \{ \$launch \}/);
});

/** A recording transport plus a stand-in activation server. */
function harness({ activate = true } = {}) {
  const shown = [];
  const activation = {
    started: 0,
    stopped: 0,
    listening: false,
    start() {
      this.started += 1;
      this.listening = true;
      return Promise.resolve({ ok: true, port: 5178 });
    },
    stop() {
      this.stopped += 1;
      this.listening = false;
      return Promise.resolve();
    },
  };
  return {
    activation,
    shown,
    transport: {
      transportAvailability: () => ({ ok: true }),
      showToast: options => {
        shown.push(options);
        return { pid: 1, outcome: Promise.resolve({ ok: true }) };
      },
      createActivationServer: () => activation,
    },
    config: { activate, settleDelayMs: 0 },
  };
}

/** The host surface `apply` touches, enough to drive one finished turn. */
function fakeHost() {
  const handlers = new Map();
  const warnings = [];
  const services = {
    sessionQuery: {
      readTitle: async () => ({ title: '修复崩溃' }),
      readSurface: async () => ({ events: [] }),
    },
    goals: { get: () => undefined },
    agents: { get: id => ({ id }) },
  };
  const session = { id: SESSION_ID, header: { id: SESSION_ID, cwd: 'C:\\work' } };
  return {
    warnings,
    on(name, handler) {
      handlers.set(name, handler);
    },
    get: name => services[name],
    logger: { info() {}, warn: message => warnings.push(message) },
    /** End one turn and let the (zero-delay) settle timer fire. */
    async finish() {
      handlers.get('session/event')(session, { type: 'turn/end', seq: 7, data: { turn: 1, reason: {} } });
      await new Promise(resolve => setTimeout(resolve, 20));
    },
    dispose() {
      handlers.get('dispose')?.();
    },
  };
}

test('an enabled activation puts the session URI on the toast', async () => {
  const { transport, shown, activation, config } = harness();
  const host = fakeHost();
  apply(host, config, transport);
  await host.finish();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].launch, `dshnotify:${SESSION_ID}`);
  assert.equal(activation.started, 1);
});

test('activation off leaves the toast exactly as it was', async () => {
  const { transport, shown, activation } = harness({ activate: false });
  const host = fakeHost();
  apply(host, { activate: false, settleDelayMs: 0 }, transport);
  await host.finish();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].launch, undefined);
  assert.equal(activation.started, 0);
});

test('a receiver that is not listening earns no launch URI', async () => {
  const { transport, shown, activation } = harness();
  activation.start = () => {
    activation.started += 1;
    return Promise.resolve({ ok: false, reason: 'port 5178 is already in use' });
  };
  const host = fakeHost();
  apply(host, { activate: true, settleDelayMs: 0 }, transport);
  await host.finish();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].launch, undefined, 'a toast pointing nowhere must not look clickable');
  assert.match(host.warnings.join('\n'), /click activation disabled/);
});

test('disposing the plugin stops the receiver', async () => {
  const { transport, activation } = harness();
  const host = fakeHost();
  apply(host, { activate: true, settleDelayMs: 0 }, transport);
  host.dispose();
  assert.equal(activation.stopped, 1);
});
