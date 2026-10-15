/**
 * Wiring tests for dsh-notify.
 *
 * The rule these pin down is the one the plugin exists for: a notification
 * appears when a task is actually finished, and not once per round of a task
 * that is still running. That rule lives in the seam between two host events —
 * `session/event`'s durable `turn/end` and `agent/status`'s idle transition —
 * so a fake host is the only way to test it without driving a real agent.
 *
 * The Windows transport is injected, so nothing here puts a toast on a screen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';

const SESSION_ID = 'session-1';
const CWD = 'C:\\work\\app';

/** A recording transport: counts what would have been shown. */
function recordingTransport({ available = true } = {}) {
  const shown = [];
  return {
    shown,
    transportAvailability: () => (available ? { ok: true } : { ok: false, reason: 'not windows' }),
    showToast: options => {
      shown.push(options);
      return { pid: 4242, outcome: Promise.resolve({ ok: true }) };
    },
  };
}

/**
 * A stand-in for the host context.
 *
 * Only the surface dsh-notify touches exists: `on`/`get`/`logger`, plus the
 * session text a real host would serve through `sessionQuery`.
 */
function fakeHost({ title = '修复登录崩溃', summary = '改了三个文件，测试通过。', goals = new Map() } = {}) {
  const handlers = new Map();
  const warnings = [];
  const services = {
    sessionQuery: {
      readTitle: async () => ({ title }),
      readSurface: async () => ({
        events: [
          { type: 'user/message', data: {} },
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: summary }] } },
          },
        ],
      }),
    },
    goals: { get: agent => goals.get(agent?.id) },
    agents: { get: id => ({ id }) },
  };
  return {
    handlers,
    warnings,
    sessionId: SESSION_ID,
    cwd: CWD,
    on(name, handler) {
      handlers.set(name, handler);
    },
    get(name) {
      return services[name];
    },
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    },
    services,
    /** Drive one durable turn end, the way the session log would. */
    turnEnd(seq, reason) {
      handlers.get('session/event')(
        { id: SESSION_ID, header: { id: SESSION_ID, cwd: CWD } },
        { type: 'turn/end', seq, time: 1_700_000_000_000, data: { turn: 1, reason } },
      );
    },
    /** Drive one agent status transition. */
    status(status) {
      handlers.get('agent/status')({ agent: { id: SESSION_ID }, status }, { id: SESSION_ID });
    },
    dispose() {
      handlers.get('session/disposed')?.({ id: SESSION_ID });
    },
  };
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const settle = 5;

test('the order of idle and turn end does not matter', async () => {
  // The regression this pins down: the first released version scheduled the
  // announcement from the `idle` transition and required `turn/end` to have
  // arrived first. A host that reports idle *before* it commits the turn end
  // therefore never scheduled anything — the notification silently never
  // appeared, with no error and nothing to look at. Whichever arrives second
  // must still produce exactly one notification.
  for (const order of ['idle-first', 'turn-end-first']) {
    const host = fakeHost();
    const transport = recordingTransport();
    apply(host, { settleDelayMs: settle }, transport);

    host.status('running');
    if (order === 'idle-first') {
      host.status('idle');
      host.turnEnd(7, { kind: 'completed' });
    } else {
      host.turnEnd(7, { kind: 'completed' });
      host.status('idle');
    }
    await tick(settle + 25);

    assert.equal(transport.shown.length, 1, `${order}: expected exactly one notification`);
    assert.equal(transport.shown[0].title, '✅ 修复登录崩溃');
    host.dispose();
  }
});

test('a turn end is announced even when no idle transition is reported', async () => {
  // Belt and braces for the same failure: a composition may not publish an idle
  // transition for a session at all. The turn end is what defines the outcome,
  // so it is what has to be able to carry the announcement.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.turnEnd(7, { kind: 'completed' });
  await tick(settle + 25);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ 修复登录崩溃');
  host.dispose();
});

test('one finished turn produces exactly one notification', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ 修复登录崩溃');
  assert.equal(transport.shown[0].body, '改了三个文件，测试通过。');
  assert.equal(transport.shown[0].sound, 'Default');
  assert.equal(transport.shown[0].silent, false);
  host.dispose();
});

test('a continuation is not announced as if the task had finished', async () => {
  // The idle transition schedules the announcement; a new turn starting inside
  // the delay is what makes it a step of something still running.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: 40 }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'completed' });
  host.status('idle');
  await tick(10);
  host.status('running'); // the session picked the work back up
  await tick(60);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a turn that ends while the agent keeps running is reported at the end', async () => {
  // Goal mode and continued work both look like this: turn ends, another turn
  // starts, and only the last one is followed by idle.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'completed' });
  await tick(2);
  assert.equal(transport.shown.length, 0, 'a turn end alone must not notify');

  host.turnEnd(11, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1, 'the finished work is announced once');
  host.dispose();
});

test('a subagent session stays silent', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.handlers.get('session/event')(
    { id: 'child-1', header: { id: 'child-1', cwd: CWD, origin: 'subagent' } },
    { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  host.handlers.get('agent/status')({ agent: { id: 'child-1' }, status: 'idle' }, { id: 'child-1' });
  await tick(settle + 20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a user-cancelled turn says nothing', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'aborted', reason: { kind: 'user' } });
  host.status('idle');
  await tick(settle + 20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a failure carries its message into the body', async () => {
  const host = fakeHost({ summary: '先试着重试。' });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(9, { kind: 'error', error: { message: 'connect ETIMEDOUT 443' } });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '❌ 修复登录崩溃');
  assert.equal(transport.shown[0].body, 'connect ETIMEDOUT 443 — 先试着重试。');
  assert.equal(transport.shown[0].sound, 'Reminder');
  host.dispose();
});

test('a goal suppresses its own rounds and announces its settlement instead', async () => {
  const goals = new Map([[SESSION_ID, { goal: { status: 'active' } }]]);
  const host = fakeHost({ goals });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  // Five rounds of a running goal: each ends, none is the task ending.
  host.status('running');
  for (let round = 1; round <= 5; round += 1) {
    host.turnEnd(round * 10, { kind: 'completed' });
    host.status('idle');
    await tick(settle + 10);
    host.status('running');
  }
  assert.deepEqual(transport.shown, [], 'rounds of a live goal stay silent');

  // The goal is met; the round driver stops and the agent goes idle.
  goals.set(SESSION_ID, { goal: { status: 'complete' } });
  host.turnEnd(99, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '🎯 修复登录崩溃');
  assert.equal(transport.shown[0].sound, 'Default');
  host.dispose();
});

test('a running goal that stops for a person is announced', async () => {
  const goals = new Map([[SESSION_ID, { goal: { status: 'active' } }]]);
  const host = fakeHost({ goals });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(20, { kind: 'blocked' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '⏸️ 修复登录崩溃');
  host.dispose();
});

test('notifyOn attention only interrupts for a person', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { notifyOn: 'attention', settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);
  assert.deepEqual(transport.shown, []);

  host.status('running');
  host.turnEnd(2, { kind: 'blocked' });
  host.status('idle');
  await tick(settle + 20);
  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '⏸️ 修复登录崩溃');
  host.dispose();
});

test('notifyOn never is silent even for a failure', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { notifyOn: 'never', settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'error', error: { message: 'boom' } });
  host.status('idle');
  await tick(settle + 20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('the sound setting overrides the per-outcome choice', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle, sound: 'silent' }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].silent, true);
  host.dispose();
});

test('a session with no title still produces a usable notification', async () => {
  const host = fakeHost({ title: '', summary: '' });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ DSH');
  assert.equal(transport.shown[0].body, '');
  host.dispose();
});

test('an unavailable platform warns and registers nothing', () => {
  const host = fakeHost();
  const transport = recordingTransport({ available: false });
  apply(host, {}, transport);

  assert.equal(host.handlers.size, 0);
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /not windows/);
});

test('a disabled plugin registers nothing', () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { enabled: false }, transport);

  assert.equal(host.handlers.size, 0);
  assert.deepEqual(host.warnings, []);
});

test('a summary read that throws degrades instead of breaking the notification', async () => {
  const host = fakeHost();
  host.services.sessionQuery.readSurface = async () => {
    throw new Error('session is gone');
  };
  host.services.sessionQuery.readTitle = async () => {
    throw new Error('session is gone');
  };
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ DSH');
  assert.deepEqual(host.warnings, []);
  host.dispose();
});

test('disposing a session cancels an announcement that has not fired', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: 40 }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  host.dispose();
  await tick(60);

  assert.deepEqual(transport.shown, []);
});
