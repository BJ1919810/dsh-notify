/**
 * The receiving end of a toast click.
 *
 * A toast shown by `powershell-toast.js` is produced by a child process, so the
 * click can never reach this one. Windows delivers a toast activation in exactly
 * two ways: to the app that owns the AppUserModelID through a registered COM
 * activator, or through a protocol activation. DSH owns neither, and its own
 * `dsh://` scheme is inert on Windows (the handler is an Electron `open-url`
 * listener, a macOS-only event), so the toast carries *this plugin's* scheme
 * instead: `dshnotify:<sessionId>`.
 *
 * That URI is handed to a small registered handler (see `assets/activate.vbs`),
 * which runs in the process the shell started — the one Windows will let raise
 * and focus the DSH window — and posts the session id back here. This module is
 * only the receiving end: a loopback-only server that holds one pending session
 * until the browser half claims it with `GET /pending`.
 *
 * Two properties are load-bearing:
 *
 * 1. A notification must never depend on this. A port that is taken, a browser
 *    half that is not loaded, a click nobody makes — all of them degrade to
 *    "the toast was shown and the click did nothing", which is exactly what the
 *    plugin did before this module existed.
 * 2. Nothing but loopback can reach it. The socket binds 127.0.0.1, and every
 *    request is checked against the peer address as well, so a request that
 *    arrives through some other route cannot plant a session id here.
 */
import { createServer } from 'node:http';

/** Port the browser half polls. Fixed because the browser half cannot discover one. */
export const DEFAULT_PORT = 5178;

/** URI scheme registered by `scripts/install-activation.cmd`. */
export const DEFAULT_SCHEME = 'dshnotify';

/**
 * How long a pending session stays claimable.
 *
 * Long enough to survive a slow window restore, short enough that a click from
 * ten minutes ago does not open a conversation the next time the page reloads.
 */
export const PENDING_TTL_MS = 120_000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Schemes that already mean something to Windows; never steal one of those. */
const RESERVED_SCHEMES = new Set(['http', 'https', 'file', 'ms-settings', 'shell', 'dsh']);

/** Session ids are minted by the host; anything else is a forged request. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** A session id from a query string, or undefined when it is not one. */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SESSION_ID.test(trimmed) ? trimmed : undefined;
}

/**
 * The URI a toast carries for one session, or undefined when it cannot be one.
 *
 * The session id is *not* percent-encoded: a URI scheme handler receives the
 * command line verbatim, and `encodeURIComponent` would only make the handler's
 * own parse harder for characters the id regex already excludes.
 */
export function activationUri(scheme, sessionId) {
  const id = normalizeSessionId(sessionId);
  if (id === undefined) return undefined;
  const name = typeof scheme === 'string' ? scheme.trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9+.-]{1,30}$/.test(name) || RESERVED_SCHEMES.has(name)) return undefined;
  return `${name}:${id}`;
}

/** The session id an activation URI carries, or undefined. */
export function sessionIdFromUri(uri, scheme = DEFAULT_SCHEME) {
  if (typeof uri !== 'string') return undefined;
  const prefix = `${String(scheme).toLowerCase()}:`;
  if (!uri.toLowerCase().startsWith(prefix)) return undefined;
  return normalizeSessionId(uri.slice(prefix.length));
}

/**
 * A single-slot handoff from "a toast was clicked" to "the page is looking".
 *
 * Kept as a plain value rather than inside the server so the expiry rule can be
 * tested without a socket.
 */
export class PendingSession {
  #entry;
  #now;

  constructor({ now = () => Date.now(), ttlMs = PENDING_TTL_MS } = {}) {
    this.#now = now;
    this.ttlMs = ttlMs;
    this.#entry = undefined;
  }

  /** Remember one click, superseding an older one. */
  remember(sessionId, at = this.#now()) {
    const id = normalizeSessionId(sessionId);
    if (id === undefined) return false;
    this.#entry = { sessionId: id, at };
    return true;
  }

  /** Read the pending click, if it is still fresh. Reading does not consume. */
  peek() {
    if (this.#entry === undefined) return undefined;
    if (this.#now() - this.#entry.at > this.ttlMs) {
      this.#entry = undefined;
      return undefined;
    }
    return this.#entry;
  }

  /** Read and clear: a session is opened once, not on every poll. */
  take() {
    const entry = this.peek();
    this.#entry = undefined;
    return entry;
  }

  clear() {
    this.#entry = undefined;
  }
}

/**
 * The loopback server the activation handler posts to.
 *
 * Not started unless the plugin is configured to, because a plugin that opens a
 * listening socket on somebody's machine should be something they asked for.
 */
export class ActivationServer {
  #server;
  #pending;
  #recent = [];
  #listening = false;

  /**
   * @param {object} [options]
   * @param {number} [options.port] - 0 picks a free port, which the tests use.
   * @param {string} [options.scheme] - the scheme to advertise in `/health`.
   * @param {object} [options.logger] - host logger; every failure is reported, never thrown.
   */
  constructor({ port = DEFAULT_PORT, scheme = DEFAULT_SCHEME, logger, now } = {}) {
    this.port = port;
    this.scheme = scheme;
    this.logger = logger;
    this.#pending = new PendingSession(now === undefined ? {} : { now });
  }

  /** The port actually bound (useful when `port: 0` was requested). */
  get address() {
    const address = this.#server?.address();
    return address !== null && typeof address === 'object' ? address : undefined;
  }

  get listening() {
    return this.#listening;
  }

  /** The pending click, or undefined. */
  peek() {
    return this.#pending.peek();
  }

  /** Remember one click. Exposed so a test can plant one without a socket. */
  remember(sessionId, at) {
    return this.#pending.remember(sessionId, at);
  }

  /**
   * Start listening.
   *
   * Resolves to a result rather than throwing: a busy port is a degraded
   * feature, not a broken plugin, and the caller reports it as such.
   *
   * @returns {Promise<{ ok: boolean, port?: number, reason?: string }>}
   */
  start() {
    if (this.#server !== undefined) return Promise.resolve({ ok: true, port: this.address?.port });
    const server = createServer((request, response) => this.#handle(request, response));
    this.#server = server;
    return new Promise(resolve => {
      server.once('error', error => {
        this.#server = undefined;
        this.#listening = false;
        resolve({ ok: false, reason: error?.code === 'EADDRINUSE' ? `port ${this.port} is already in use` : String(error?.message ?? error) });
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.#listening = true;
        resolve({ ok: true, port: this.address?.port });
      });
    });
  }

  /** Stop listening; safe to call when never started. */
  async stop() {
    const server = this.#server;
    this.#server = undefined;
    this.#listening = false;
    this.#pending.clear();
    this.#recent.length = 0;
    if (server === undefined) return;
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  #handle(request, response) {
    // Belt and braces: the socket already binds loopback, so a non-loopback peer
    // means something is relaying requests to this port. Either way it is not
    // the activation handler.
    if (!LOOPBACK.has(String(request.socket?.remoteAddress ?? ''))) {
      respond(response, 403, { error: 'loopback only' });
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      respond(response, 400, { error: 'bad url' });
      return;
    }

    if (request.method === 'OPTIONS') {
      respond(response, 204, undefined);
      return;
    }

    // Diagnostics are not recorded, so reading them does not hide the traffic
    // they describe.
    if (url.pathname !== '/peek') this.#record(request, url);

    if (url.pathname === '/health') {
      respond(response, 200, { ok: true, scheme: this.scheme, port: this.address?.port });
      return;
    }

    if (url.pathname === '/peek') {
      // Non-consuming: it answers "what has this socket seen", which is the only
      // way to tell a page that polls from a page that never loaded the bundle.
      respond(response, 200, { pending: this.#pending.peek() ?? null, recent: this.#recent });
      return;
    }

    if (url.pathname === '/pending' && (request.method === 'GET' || request.method === 'HEAD')) {
      // Reading consumes: the page opens a session once, and a reload must not
      // re-open it. A missing entry is `null`, not an error — polling is normal.
      //
      // `?peek=1` asks without consuming. DSH can mount a client tree in a
      // hidden document, and a claim made there opens the session somewhere
      // nobody is looking; such a surface watches without taking the click.
      if (url.searchParams.get('peek') === '1') {
        respond(response, 200, this.#pending.peek() ?? null);
        return;
      }
      respond(response, 200, this.#pending.take() ?? null);
      return;
    }

    if (url.pathname === '/activate') {
      const id = normalizeSessionId(url.searchParams.get('s') ?? url.searchParams.get('session') ?? '');
      if (id === undefined) {
        respond(response, 400, { error: 'missing session id' });
        return;
      }
      this.#pending.remember(id);
      this.logger?.info?.(`dsh-notify: notification clicked for ${id}`);
      respond(response, 204, undefined);
      return;
    }

    respond(response, 404, { error: 'not found' });
  }

  /**
   * Keep the last few requests, whoever made them.
   *
   * The interesting fields are the ones that say which document sent the
   * request: `Origin`/`Referer` name the page, and `Sec-Fetch-Site` says whether
   * it was same-origin. Without this, a poll that arrives from somewhere other
   * than the visible window is indistinguishable from one that does not arrive.
   */
  #record(request, url) {
    this.#recent.push({
      at: Date.now(),
      method: request.method,
      path: url.pathname,
      query: url.search === '' ? undefined : url.search,
      origin: request.headers.origin,
      referer: request.headers.referer,
      site: request.headers['sec-fetch-site'],
      agent: String(request.headers['user-agent'] ?? '').slice(0, 120),
    });
    if (this.#recent.length > 20) this.#recent.shift();
  }
}

function respond(response, status, body) {
  const headers = {
    // The page is served from `dsh-app://app` (desktop) or `http://127.0.0.1:…`
    // (browser), so every request here is cross-origin and a simple POST/GET
    // with no custom headers needs no preflight. The wildcard is deliberate:
    // this socket only answers on loopback and only carries a session id.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  };
  if (body === undefined) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Content-Length'] = Buffer.byteLength(text);
  response.writeHead(status, headers);
  response.end(text);
}
