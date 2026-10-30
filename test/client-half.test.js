/**
 * Headless contract test for `lib/client.js` — the browser half of dsh-notify.
 *
 * DSH is not involved. The test reproduces the two things the Web shell does to
 * a client bundle and nothing else:
 *
 *   1. it provides `window.__ModuleLoader__` and executes the bundle, which
 *      must only register one `{ id, factory }` under the package name;
 *   2. it materializes the factory (`factory(require)`) and hands the returned
 *      namespace to Cordis as the plugin (`exports.apply` / `exports.inject`).
 *
 * Then it mounts the plugin against a fake `ctx` whose `uiWorkspace.openSession`
 * is a spy, and drives the activation endpoint through a scripted fake `fetch`
 * and a fake timer queue. Everything is plain Node (`node:test`, `node:vm`), so
 * `node --test test/client-half.test.js` is repeatable with no network, no DSH,
 * no browser and no dependency install.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CLIENT_FILE = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const CLIENT_SOURCE = readFileSync(CLIENT_FILE, 'utf8');

/** The graph row id the client module system requires: the package name. */
const PACKAGE_ID = 'dsh-notify';
/** The loopback endpoint the Host half serves, per the team contract. */
const ENDPOINT = 'http://127.0.0.1:5178/pending';

/** Let every promise chain started by a timer callback settle. */
async function settle() {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** A deterministic replacement for the page's timer queue. */
class TimerQueue {
  constructor() {
    this.nextId = 1;
    this.tasks = new Map();
    // Arrow fields: the bundle calls these as bare globals, so `this` is not
    // the queue instance there.
    this.setTimeout = (callback, delay) => {
      const id = this.nextId++;
      this.tasks.set(id, { callback, delay });
      return id;
    };
    this.clearTimeout = (id) => {
      this.tasks.delete(id);
    };
  }

  /** Armed timers, oldest first. */
  get pending() {
    return [...this.tasks.values()];
  }

  /** Armed delays, oldest first. */
  get delays() {
    return this.pending.map((task) => task.delay);
  }

  /**
   * Fire every timer armed at call time, oldest first, then settle promises.
   *
   * Timers armed by those callbacks belong to the next round.
   */
  async firePending() {
    const batch = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of batch) task.callback();
    await settle();
  }
}

/** A fake `fetch` that answers from a script, one responder per request. */
function scriptedFetch(responders) {
  const calls = [];
  const reports = [];
  const reposts = [];
  const fetch = async (url, init) => {
    // Diagnostic reports and handed-back clicks are fire-and-forget and must not
    // consume a scripted answer: they are not the read under test.
    if (String(url).includes('/report')) {
      reports.push({ url: String(url), init });
      return { ok: true, status: 204, json: async () => null };
    }
    if (String(url).includes('/activate?s=')) {
      reposts.push(String(url));
      return { ok: true, status: 204, json: async () => null };
    }
    calls.push({ url, init });
    const responder = responders.shift();
    if (responder === undefined) {
      throw new Error(`unexpected fetch #${calls.length}: the scenario has no responder left`);
    }
    return responder(url, init);
  };
  return { fetch, calls, reports, reposts };
}

/** A responder that answers HTTP 200 with the given JSON body. */
const body = (json) => async () => ({
  ok: true,
  status: 200,
  json: async () => json,
});

/** A responder that answers with a non-2xx status. */
const httpStatus = (status) => async () => ({
  ok: false,
  status,
  json: async () => null,
});

/** A responder that rejects like a refused connection / blocked CORS request. */
const transportFailure = (message) => async () => {
  throw new Error(message);
};

/** A responder whose answer the test releases explicitly. */
function gatedResponder() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    responder: async () => {
      await gate;
      return { ok: true, status: 200, json: async () => null };
    },
    release,
  };
}

/** A tiny EventTarget stand-in for `window` / `document`. */
function fakeEventTarget(extra) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((item) => item !== handler),
      );
    },
    dispatch(type) {
      for (const handler of listeners.get(type) ?? []) handler();
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

/** A console whose warnings the test can inspect. */
function recordingConsole() {
  const warnings = [];
  return {
    warnings,
    console: {
      warn: (...args) => warnings.push(args.map((value) => String(value)).join(' ')),
      log: () => {},
      error: (...args) => warnings.push(args.map((value) => String(value)).join(' ')),
    },
  };
}

/**
 * Execute the bundle the way the shell does, then materialize its factory.
 *
 * @param options - scripted responders plus optional fake `window`/`document`.
 * @returns the capture of everything the test needs to drive the plugin.
 */
function boot({ responders = [], windowObject, documentObject } = {}) {
  const timers = new TimerQueue();
  const { fetch, calls: fetchCalls, reports, reposts } = scriptedFetch(responders);
  const recorder = recordingConsole();
  const registrations = [];

  const win = windowObject ?? {};
  win.__ModuleLoader__ = {
    load: (registration) => registrations.push(registration),
  };

  const sandbox = {
    window: win,
    fetch,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: recorder.console,
  };
  if (documentObject !== undefined) sandbox.document = documentObject;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_FILE });

  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory');

  const registration = registrations[0];
  const exports = registration.factory((specifier) => {
    throw new Error(`this bundle must require no platform module, but asked for "${specifier}"`);
  });

  return {
    registration,
    exports,
    timers,
    fetchCalls,
    reports,
    reposts,
    warnings: recorder.warnings,
    windowObject: win,
  };
}

/**
 * Mount the exported Cordis plugin against a fake client context.
 *
 * @param exports - the materialized module namespace.
 * @param options - optional `openSession` side effect for the failure path.
 * @returns the spy calls and the effect disposer.
 */
function mount(exports, { onOpen } = {}) {
  const openCalls = [];
  const disposers = [];
  const listeners = new Map();
  const ctx = {
    uiWorkspace: {
      openSession(sessionId) {
        openCalls.push(sessionId);
        if (onOpen !== undefined) onOpen(sessionId);
      },
    },
    // The plugin releases its timer through a `dispose` listener rather than an
    // effect: Cordis rejects effect creation on a context that is being created
    // or reloaded, which fails the whole client import.
    on(name, listener) {
      listeners.set(name, listener);
    },
  };
  exports.apply(ctx);
  return {
    ctx,
    openCalls,
    dispose() {
      const listener = listeners.get('dispose');
      if (listener !== undefined) disposers.push(listener);
      for (const disposer of disposers.splice(0).reverse()) disposer();
    },
  };
}

// ---------------------------------------------------------------------------
// Bundle loading contract
// ---------------------------------------------------------------------------

test('bundle registers one factory under the package name and needs no platform module', () => {
  const harness = boot();

  assert.equal(harness.registration.id, PACKAGE_ID);
  assert.equal(typeof harness.registration.factory, 'function');
  assert.equal(typeof harness.exports.apply, 'function');
  assert.equal(harness.exports.inject.length, 1);
  assert.equal(harness.exports.inject[0], 'uiWorkspace');
  assert.equal(harness.exports.ACTIVATION_ENDPOINT, ENDPOINT);
  assert.equal(harness.exports.POLL_INTERVAL_MS, 400);

  // Lazy CJS model: registering and materializing the module must not poll,
  // arm a timer or open anything. Only Cordis mounting the plugin starts work.
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.timers.pending.length, 0);
});

test('mounting without uiWorkspace.openSession warns and does nothing', () => {
  const harness = boot({ responders: [] });

  harness.exports.apply({
    effect() {
      throw new Error('the polling effect must not start without uiWorkspace');
    },
  });

  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /uiWorkspace/);
  assert.equal(harness.timers.pending.length, 0);
});

// ---------------------------------------------------------------------------
// Polling contract
// ---------------------------------------------------------------------------

test('the first tick is immediate and the next one is one second later', async () => {
  const harness = boot({ responders: [body(null), body(null)] });

  mount(harness.exports);
  assert.deepEqual(harness.timers.delays, [0]);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 1);
  assert.deepEqual(harness.timers.delays, [400]);
});

test('the request is a no-store GET of the loopback endpoint', async () => {
  const harness = boot({ responders: [body(null)] });

  mount(harness.exports);
  await harness.timers.firePending();

  assert.equal(harness.fetchCalls.length, 1);
  const [call] = harness.fetchCalls;
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.headers.accept, 'application/json');
});

test('an empty read opens nothing and keeps polling', async () => {
  const harness = boot({ responders: [body(null), body(null)] });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.deepEqual(view.openCalls, []);
  assert.deepEqual(harness.timers.delays, [400]);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 2);
  assert.deepEqual(view.openCalls, []);
  view.dispose();
});

test('a pending session id opens exactly once, and a duplicate read does not reopen it', async () => {
  const harness = boot({
    responders: [body({ sessionId: 's-1', at: 1 }), body({ sessionId: 's-1', at: 2 })],
  });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.deepEqual(view.openCalls, ['s-1']);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 2);
  assert.deepEqual(view.openCalls, ['s-1'], 'the same id must not reopen while one claim is active');
  view.dispose();
});

test('a different id opens, and an empty read re-arms a later click of the same id', async () => {
  const harness = boot({
    responders: [
      body({ sessionId: 's-a', at: 1 }),
      body({ sessionId: 's-b', at: 2 }),
      body(null),
      body({ sessionId: 's-a', at: 3 }),
    ],
  });
  const view = mount(harness.exports);

  for (let tick = 0; tick < 4; tick += 1) await harness.timers.firePending();

  assert.deepEqual(view.openCalls, ['s-a', 's-b', 's-a']);
  view.dispose();
});

test('malformed payloads are ignored without opening or warning', async () => {
  const harness = boot({
    responders: [
      body({}),
      body({ sessionId: 42 }),
      body({ sessionId: '' }),
      body('a session id as a bare string'),
      body([]),
      body(true),
    ],
  });
  const view = mount(harness.exports);

  for (let tick = 0; tick < 6; tick += 1) await harness.timers.firePending();

  assert.deepEqual(view.openCalls, []);
  assert.deepEqual(harness.warnings, []);
  view.dispose();
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

test('a transport failure is logged once and polling continues', async () => {
  const harness = boot({
    responders: [
      transportFailure('Failed to fetch'),
      transportFailure('Failed to fetch'),
      body(null),
    ],
  });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /activation poll failed/);
  assert.equal(harness.timers.pending.length, 1, 'polling must keep going after a failure');

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.warnings.length, 1, 'an unchanged failure must not repeat every second');

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 3);
  assert.deepEqual(view.openCalls, []);
  view.dispose();
});

test('a non-2xx answer is a contained failure, not a jump', async () => {
  const harness = boot({ responders: [httpStatus(503), body(null)] });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /HTTP 503/);
  assert.deepEqual(view.openCalls, []);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 2, 'polling continues after the failure');
  view.dispose();
});

test('an openSession failure is contained and polling continues', async () => {
  const harness = boot({
    responders: [body({ sessionId: 's-unknown', at: 1 }), body(null)],
  });
  const view = mount(harness.exports, {
    onOpen() {
      throw new Error('sessions.retain: unknown session s-unknown');
    },
  });

  await harness.timers.firePending();
  assert.deepEqual(view.openCalls, ['s-unknown']);
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /could not open session s-unknown/);
  assert.match(harness.warnings[0], /unknown session/);
  assert.equal(harness.timers.pending.length, 1, 'an open failure must not stop the poll loop');

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 2);
  view.dispose();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('dispose stops the timer and removes the window listeners', async () => {
  const win = fakeEventTarget();
  const page = fakeEventTarget({ visibilityState: 'visible' });
  const harness = boot({
    windowObject: win,
    documentObject: page,
    responders: [body(null), body(null)],
  });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(win.listenerCount('focus'), 1);
  assert.equal(page.listenerCount('visibilitychange'), 1);

  view.dispose();
  assert.equal(harness.timers.pending.length, 0);
  assert.equal(win.listenerCount('focus'), 0);
  assert.equal(page.listenerCount('visibilitychange'), 0);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 1, 'a disposed plugin must not poll');
});

test('bringing the window forward polls immediately instead of waiting for the tick', async () => {
  const win = fakeEventTarget();
  const harness = boot({
    windowObject: win,
    responders: [body(null), body({ sessionId: 's-focus', at: 1 })],
  });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.deepEqual(harness.timers.delays, [400]);

  win.dispatch('focus');
  assert.deepEqual(harness.timers.delays, [0], 'focus replaces the armed tick with an immediate one');
  assert.equal(harness.timers.pending.length, 1, 'focus must not stack a second tick');

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 2);
  assert.deepEqual(view.openCalls, ['s-focus']);
  view.dispose();
});

test('a hidden surface watches without consuming the click', async () => {
  const win = fakeEventTarget();
  const page = fakeEventTarget({ visibilityState: 'hidden' });
  const harness = boot({
    windowObject: win,
    documentObject: page,
    responders: [body({ sessionId: 'session-x', at: 1 }), body(null)],
  });
  const view = mount(harness.exports);

  // DSH can mount a client tree in a hidden document; consuming a click there
  // would open the session in that tree, invisible to the person who clicked.
  // So a hidden surface reads with `?peek=1`, which leaves the click for the
  // visible surface, and never calls `openSession`.
  await harness.timers.firePending();
  assert.deepEqual(view.openCalls, [], 'a hidden surface must not open a session');
  assert.equal(harness.fetchCalls[0].url, `${ENDPOINT}?peek=1`);
  assert.deepEqual(harness.timers.delays, [400]);

  page.visibilityState = 'visible';
  page.dispatch('visibilitychange');
  assert.deepEqual(harness.timers.delays, [0]);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls[1].url, ENDPOINT, 'a visible surface consumes again');
  view.dispose();
});

test('an occluded window that just came forward still takes the click', async () => {
  // A toast click raises DSH before posting the id, so the main window is often
  // still `hidden` (occluded by whatever was in front) when the id arrives. It
  // must claim it anyway — otherwise the feature only works while DSH already
  // has the foreground, which defeats the point.
  const win = fakeEventTarget();
  const page = fakeEventTarget({ visibilityState: 'hidden', hasFocus: () => false });
  const harness = boot({
    windowObject: win,
    documentObject: page,
    responders: [body({ sessionId: 'session-y', at: 1 })],
  });
  const view = mount(harness.exports);

  win.dispatch('focus');
  await harness.timers.firePending();

  assert.equal(harness.fetchCalls[0].url, ENDPOINT, 'focus grants the claim even while occluded');
  assert.deepEqual(view.openCalls, ['session-y']);
  view.dispose();
});

test('focus does not add a request while one is already outstanding', async () => {
  const win = fakeEventTarget();
  const gate = gatedResponder();
  const harness = boot({ windowObject: win, responders: [gate.responder] });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.timers.pending.length, 0, 'no tick is armed while a request is in flight');

  win.dispatch('focus');
  assert.equal(harness.timers.pending.length, 0);
  assert.equal(harness.fetchCalls.length, 1, 'focus must not start an overlapping request');

  gate.release();
  await settle();
  assert.deepEqual(harness.timers.delays, [400], 'polling resumes after the request settles');
  view.dispose();
});

test('dispose while a request is in flight leaves no timer behind', async () => {
  const gate = gatedResponder();
  const harness = boot({ responders: [gate.responder] });
  const view = mount(harness.exports);

  await harness.timers.firePending();
  assert.equal(harness.fetchCalls.length, 1);

  view.dispose();
  gate.release();
  await settle();

  assert.equal(harness.timers.pending.length, 0);
  assert.equal(harness.fetchCalls.length, 1);
});
