/**
 * dsh-notify — browser half: turn a clicked Windows toast into a session jump.
 *
 * ## What this file is
 *
 * A prebuilt DSH client bundle, not an ES module. The Web shell executes this
 * classic script while it registers plugin factories: the only top-level
 * statement is `window.__ModuleLoader__.load({ id, factory })`. Running the
 * bundle only registers the factory; the module body — everything below the
 * `factory` line — runs when the module system materializes it. `factory`
 * receives a synchronous `require` over the platform module table, returns
 * `module.exports`, and the shell hands that namespace to Cordis as a plugin
 * (`exports.apply` / `exports.inject`).
 *
 * Evidence for that contract, from the packaged DSH (`app.asar`, 0.2.1-rc.2):
 * `dsh/node_modules/@deepseek-ai/dsh-client-ui-brand-official/lib/client.js`
 * (packed offset 18861350) is the minimal working bundle and has exactly this
 * shape; `dsh-client-modules/lib/client.js` @18300039 lines 483-491 creates the
 * Loader entry with `{ name: id }`, lines 661-714 register the factory under
 * `registration.id`, and lines 743-775 fail the row when a script executes
 * without registering that exact id. The id is therefore the package name: the
 * graph row id is the resolved manifest package name
 * (`dsh-client-modules/lib/index.js` @18346331, `resolveMeta` / `graphRow`).
 *
 * ## Why this half talks HTTP to loopback
 *
 * The Windows toast is raised by the Host half in an out-of-process
 * `powershell.exe`; a toast click cannot call back into the host process. The
 * Host half therefore publishes the clicked session id on a loopback-only HTTP
 * endpoint (`GET /pending`, read-to-consume) and this half claims it. That
 * endpoint is the whole protocol; this file knows nothing about `powershell`,
 * the toast XML or the protocol handler.
 *
 * This bundle requires no platform module at all: polling needs only the
 * standard `fetch` / `setTimeout` and one Cordis service. No `dsh.client.external`
 * declaration is needed for it (see `dsh-client-modules/README.zh.md` line 51).
 *
 * ## Which service is used, and what `openSession` does
 *
 * `ctx.uiWorkspace.openSession(sessionId)` is provided by
 * `@deepseek-ai/dsh-client-ui-workspace` (`super(ctx, "uiWorkspace")` at
 * `dsh-client-ui-workspace/lib/client.js` @44308875 line 1380). It is
 * synchronous and returns `undefined`: it retains the session for `mainView`,
 * sets the selection and reveals the main panel, without awaiting history
 * (`openSession` line 1470, `replaceMain` line 1651; the package README.zh.md
 * line 74 states the same). A target may be a known session id or a direct
 * parent-child subagent address; this half only ever passes the id string.
 *
 * The service name is the only requirement, so this module declares it in
 * Cordis `inject`. `dsh.client.inject` in `package.json` is a different thing:
 * package specifiers that must arrive before this bundle is materialized, not
 * services — this bundle needs none of those.
 *
 * ## Failure accounting
 *
 * Everything is best-effort and silent until it fails: a missing endpoint, a
 * CORS refusal or a session the client cannot retain must not break the page.
 * Poll errors are logged once per distinct message and retried on the next
 * tick; `openSession` errors are logged and forgotten, because the endpoint has
 * already consumed the click and a blind retry could jump the user later.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    //#region contract
    /**
     * Where the Host half publishes one clicked session id.
     *
     * Loopback only, no authentication: the payload is a session id the local
     * user just clicked, and the reader consumes it. The port is the Host
     * half's default (`lib/config.js`, `activationPort`).
     */
    const ACTIVATION_ENDPOINT = 'http://127.0.0.1:5178/pending';

    /**
     * How often the endpoint is polled while the page is open.
     *
     * The focus/visibility listeners below collapse the wait to zero whenever a
     * click brings the window forward, but a click can also arrive while DSH is
     * already in front — then no event fires and this interval *is* the delay.
     * 400 ms keeps that worst case under half a second at a cost of 2.5
     * loopback requests per second (a few hundred bytes), which is worth it for
     * a gesture that should feel instant.
     */
    const POLL_INTERVAL_MS = 400;

    /** Console prefix for every diagnostic this bundle writes. */
    const LOG_PREFIX = '[dsh-notify]';

    /** The Cordis services this browser plugin waits for before applying. */
    const inject = ['uiWorkspace'];
    //#endregion

    //#region payload
    /**
     * The session id carried by one `GET /pending` response.
     *
     * The contract is `{ sessionId, at }` or `null`; everything else — a
     * hand-edited server, a proxy error page that still parses as JSON — is
     * treated as "nothing to open" rather than as an error worth logging.
     *
     * @param value - decoded JSON response body.
     * @returns the session id, or undefined when the body carries none.
     */
    function pendingSessionId(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const sessionId = value.sessionId;
      return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
    }
    //#endregion

    /**
     * Start claiming clicked notifications and opening their sessions.
     *
     * One `ctx.effect` owns the polling loop and the two window listeners, so
     * unloading the plugin (or a hot replacement of this bundle) stops every
     * timer it created.
     *
     * @param ctx - the browser plugin context, with `uiWorkspace` injected.
     */
    function apply(ctx) {
      const workspace = ctx.uiWorkspace;
      if (workspace === undefined || workspace === null || typeof workspace.openSession !== 'function') {
        console.warn(`${LOG_PREFIX} client half idle: ctx.uiWorkspace.openSession is unavailable`);
        return;
      }
      // Captured once so a test (or a host that installs a fetch shim after
      // boot) sees the same function every tick.
      const fetchImpl = typeof fetch === 'function' ? fetch : undefined;
      if (fetchImpl === undefined) {
        console.warn(`${LOG_PREFIX} client half idle: fetch is unavailable in this page`);
        return;
      }
      const page = typeof document === 'undefined' ? undefined : document;

      /**
       * Whether opening a session here would be seen by a person.
       *
       * DSH mounts client trees in more than one document (a popped-out or
       * background view shares the origin with the main window), and every one
       * of them polls. A claim made in a hidden tree opens the session *there* —
       * the window the person is looking at would not change. So a hidden
       * surface watches with `?peek=1`, which does not consume the click: the
       * visible surface takes it on its next tick.
       */
      /**
       * The last moment this document was in front.
       *
       * `visibilityState` alone is not the right question: a window that is
       * merely occluded (another app on top, DevTools overlapping) also reports
       * `hidden`, and that is exactly the state a toast click is meant to end —
       * the helper raises DSH first. So a surface may act if it is visible *or*
       * if it held the foreground in the last few seconds. A background
       * WebContentsView never gets that focus, so it never claims a click.
       */
      let lastFocusedAt = 0;
      if (page !== undefined && typeof page.hasFocus === 'function' && page.hasFocus()) lastFocusedAt = Date.now();
      const FOCUS_GRACE_MS = 15000;

      const canAct = () => {
        if (typeof document === 'undefined') return true;
        if (document.visibilityState !== 'hidden') return true;
        return Date.now() - lastFocusedAt < FOCUS_GRACE_MS;
      };

      /** The read for this surface: consuming when visible, watching when not. */
      const readUrl = () => (canAct() ? ACTIVATION_ENDPOINT : `${ACTIVATION_ENDPOINT}?peek=1`);

      /**
       * Start the polling loop and return its disposer.
       *
       * Deliberately *not* `ctx.effect`: on a client tree that is being created
       * or reloaded Cordis rejects effect creation with `cannot create effect on
       * inactive context`, and that rejection surfaces as a failed module import
       * for the whole plugin row. A `dispose` listener has no such phase
       * restriction, so the timers and window listeners are released the same
       * way without risking the import.
       */
      const startPolling = () => {
        /** The single in-flight-or-scheduled tick, so ticks never overlap. */
        let timer;
        /** Set while a request is outstanding; focus events must not add a second. */
        let inFlight = false;
        /** Set by the disposer; no callback may schedule or open after it. */
        let disposed = false;
        /** The last id opened by this page, cleared by an empty read. */
        let lastHandledId;
        /** The last poll failure message, so a persistent failure logs once. */
        let lastWarning;

        /**
         * Arm the next tick. The delay is zero for the first tick and for a
         * wake-up, `POLL_INTERVAL_MS` after every settled request.
         *
         * @param delay - milliseconds until the next poll.
         */
        function schedule(delay) {
          if (disposed) return;
          timer = setTimeout(poll, delay);
        }

        /**
         * Poll now because the window came forward.
         *
         * A click may be waiting while the page was hidden; Chromium throttles
         * hidden-page timers, so the focus/visibility path is what keeps the
         * jump instant. Replacing the armed timer also keeps exactly one tick
         * pending.
         */
        function pollNow() {
          if (disposed || inFlight) return;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          schedule(0);
        }

        /**
         * Open one claimed session, containing every failure it can report.
         *
         * `openSession` throws synchronously when the id is not in the client's
         * session catalog yet (`sessions.retain: unknown session <id>`, raised
         * by `dsh-api-session-controller`'s manager while retaining the
         * mainView reference). That is a transient boot-order condition, not a
         * reason to break the poll loop; the click is already consumed, so it
         * is only logged.
         *
         * @param sessionId - the id read from the activation endpoint.
         */
        function open(sessionId) {
          try {
            workspace.openSession(sessionId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`${LOG_PREFIX} could not open session ${sessionId}: ${message}`);
          }
        }

        /**
         * Read the endpoint once, then claim whatever it returned.
         *
         * The endpoint consumes on read, so one response is one click. A
         * repeated id is only possible from an overlapping or replayed read:
         * the id is skipped until an empty read (`null`) ends that claim, which
         * still lets the same notification be clicked again later.
         */
        async function poll() {
          timer = undefined;
          if (disposed || inFlight) return;
          inFlight = true;
          try {
            const response = await fetchImpl(readUrl(), {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            });
            if (response === undefined || response === null || response.ok !== true) {
              const status = response === undefined || response === null ? 'no response' : String(response.status);
              throw new Error(`activation endpoint answered HTTP ${status}`);
            }
            const pending = await response.json();
            if (disposed) return;
            if (pending === null) {
              lastHandledId = undefined;
            } else {
              const sessionId = pendingSessionId(pending);
              if (sessionId !== undefined && sessionId !== lastHandledId) {
                // A watcher never acts: on a hidden surface this read did not
                // consume anything, so the visible surface still has the click.
                if (!canAct()) return;
                lastHandledId = sessionId;
                open(sessionId);
              }
            }
            lastWarning = undefined;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message !== lastWarning) {
              lastWarning = message;
              console.warn(`${LOG_PREFIX} activation poll failed (retrying): ${message}`);
            }
          } finally {
            inFlight = false;
            if (!disposed) schedule(POLL_INTERVAL_MS);
          }
        }

        const view = typeof window === 'undefined' ? undefined : window;
        const page = typeof document === 'undefined' ? undefined : document;
        const onFocus = () => {
          lastFocusedAt = Date.now();
          pollNow();
        };
        const onVisibility = () => {
          if (page === undefined) return;
          if (page.visibilityState !== 'visible') return;
          lastFocusedAt = Date.now();
          pollNow();
        };
        if (view !== undefined && typeof view.addEventListener === 'function') {
          view.addEventListener('focus', onFocus);
        }
        if (page !== undefined && typeof page.addEventListener === 'function') {
          page.addEventListener('visibilitychange', onVisibility);
        }

        schedule(0);

        return () => {
          disposed = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (view !== undefined && typeof view.removeEventListener === 'function') {
            view.removeEventListener('focus', onFocus);
          }
          if (page !== undefined && typeof page.removeEventListener === 'function') {
            page.removeEventListener('visibilitychange', onVisibility);
          }
        };
      };

      const stopPolling = startPolling();
      if (typeof ctx.on === 'function') ctx.on('dispose', stopPolling);
    }

    // Extra exports are inert for Cordis and are here so a headless test can
    // pin the contract without re-declaring the literal values.
    exports.ACTIVATION_ENDPOINT = ACTIVATION_ENDPOINT;
    exports.POLL_INTERVAL_MS = POLL_INTERVAL_MS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
