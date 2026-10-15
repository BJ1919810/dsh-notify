/**
 * dsh-notify — a Windows notification when a DSH task finishes.
 *
 * ## What "finished" means here
 *
 * The host offers two independent signals, and neither is sufficient alone:
 *
 * - `session/event` carries a durable `turn/end` with the reason the turn
 *   closed (`completed`, `error`, `aborted`, …), but a session can end a turn
 *   and immediately start the next one — that is exactly how goal mode and
 *   continued work behave. Announcing each of those would interrupt a person
 *   once per round for a task that is still running.
 * - `agent/status` reports `idle` only once no driver remains scheduled, which
 *   is the real "nothing further will happen on its own" moment, but it says
 *   nothing about how the work ended.
 *
 * So a turn ending is recorded, not announced, and the announcement happens at
 * the idle transition. That is what makes one notification mean one genuinely
 * finished piece of work rather than one round of something still running.
 *
 * ## Goals
 *
 * Goal mode runs one turn per round, so with the default setting every
 * intermediate round stays silent and the goal's own settlement (`complete` or
 * `blocked`) is announced once. A turn that stops because it needs a person —
 * a question, a block, an error — is announced either way, because a goal
 * waiting on a human is no longer running on its own.
 *
 * Everything decision-shaped lives in `format.js` and everything that touches
 * Windows lives in `powershell-toast.js`; this file is wiring, because wiring
 * is the part that can only be read next to the host's event contracts.
 */
import Schema from '@deepseek-ai/schemastery';

import { NOTIFY_ON, SETTLE_DELAY_MAX_MS, SOUNDS, normalize } from './config.js';
import {
  buildNotification,
  isAttentionKind,
  isPending,
  kindForTurnEnd,
  notificationForGoal,
  notificationForTurn,
} from './format.js';
import { showToast, transportAvailability } from './powershell-toast.js';

export const name = 'dsh-notify';

/**
 * `sessionQuery` is optional on purpose: without it a notification loses its
 * title and summary, which is a degraded notification and not a broken plugin,
 * so it must not gate loading.
 */
export const inject = { optional: ['sessionQuery'] };

export { normalize };

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('总开关。关闭后插件照常加载，但不发送任何通知。'),
  notifyOn: Schema.union(NOTIFY_ON)
    .default('every-turn')
    .description(
      '通知时机。every-turn：每个回合结束通知一次，但挂了目标的会话只在目标结束（完成／阻塞）时通知；attention：只在 agent 停下来等人（提问／阻塞／报错）时通知；never：从不通知。',
    ),
  onlyMainSessions: Schema.boolean()
    .default(true)
    .description('不通知子代理（subagent）会话，只通知你自己开的会话。'),
  settleDelayMs: Schema.number()
    .min(0)
    .max(SETTLE_DELAY_MAX_MS)
    .step(1)
    .default(400)
    .description('agent 进入空闲后再等这么久才发通知（毫秒），用于把紧接着继续的几个回合合并成一条。'),
  includeSummary: Schema.boolean()
    .default(true)
    .description('在通知正文里带上会话标题和最后一条回复的摘要。'),
  includeCwd: Schema.boolean().default(false).description('在通知里附带工作目录，便于区分同时运行的多个会话。'),
  summaryLimit: Schema.number()
    .min(0)
    .max(1000)
    .step(1)
    .default(220)
    .description('摘要正文的最大字符数，超出部分以省略号截断。'),
  sound: Schema.union(['kind', 'silent', ...SOUNDS])
    .default('kind')
    .description(
      '通知声音。kind：按结果类型自动选择（完成用 Default，报错用 Reminder）；silent：静音；其余为 WinRT 提示音名称。',
    ),
  appId: Schema.string()
    .default('')
    .description(
      '可选的 AppUserModelID（例如某个应用快捷方式的 AUMID）。留空则使用 DSH_APP_USER_MODEL_ID 环境变量，再回退到 Windows PowerShell。',
    ),
});

/**
 * @param {object} ctx - the host context Cordis hands a plugin.
 * @param {object} [config] - raw config; normalized before use.
 * @param {object} [transport] - the Windows transport. Production never passes
 *   this; tests inject a recording transport so the wiring can be exercised
 *   without putting a toast on somebody's screen.
 */
export function apply(ctx, config, transport = { showToast, transportAvailability }) {
  const settings = normalize(config);

  // Checked before the platform: a user who turned the plugin off has said what
  // they want, and telling them the platform is unsupported on top of that is
  // noise. Both cases stay loaded rather than throwing, because one plugin must
  // not be able to stop a host from booting.
  if (!settings.enabled) {
    ctx.logger?.info?.('dsh-notify: loaded but disabled by config');
    return;
  }

  const availability = transport.transportAvailability();
  if (!availability.ok) {
    ctx.logger?.warn?.(`dsh-notify: notifications disabled — ${availability.reason}`);
    return;
  }

  /**
   * One record per direct session. It holds only what must outlive the event
   * that produced it — the turn's outcome, so it can be reported at the idle
   * transition — plus the title and working directory, which are attributes of
   * the session rather than of the turn.
   */
  const records = new Map();

  const stateFor = sessionId => {
    let record = records.get(sessionId);
    if (record === undefined) {
      record = {
        sessionId,
        pendingKind: null,
        pendingDetail: '',
        pendingSeq: -1,
        title: '',
        cwd: '',
        summary: '',
        timer: null,
      };
      records.set(sessionId, record);
    }
    return record;
  };

  const cancel = record => {
    if (record.timer !== null) {
      clearTimeout(record.timer);
      record.timer = null;
    }
  };

  const clearPending = record => {
    record.pendingKind = null;
    record.pendingDetail = '';
    record.pendingSeq = -1;
  };

  const announce = (record, kind, detail) => {
    const payload = buildNotification({
      kind,
      title: record.title,
      cwd: record.cwd,
      summary: record.summary,
      detail,
      includeCwd: settings.includeCwd,
      bodyLimit: settings.summaryLimit,
    });
    const silent = settings.sound === 'silent';
    const sound = settings.sound === 'kind' ? payload.sound : settings.sound;
    try {
      const { outcome } = transport.showToast({
        appId: settings.appId || undefined,
        title: payload.title,
        body: payload.body,
        silent,
        sound,
      });
      // Reported, never awaited: the turn that triggered this must not wait on
      // PowerShell. The rejection handler is a belt-and-braces guard — a toast
      // that fails must not become an unhandled rejection in the host.
      outcome?.then?.(
        result => {
          if (!result?.ok) ctx.logger?.warn?.(`dsh-notify: toast was not shown — ${result?.reason ?? 'unknown'}`);
        },
        error => {
          ctx.logger?.warn?.(`dsh-notify: toast failed — ${describe(error)}`);
        },
      );
    } catch (error) {
      ctx.logger?.warn?.(`dsh-notify: could not start the notifier — ${describe(error)}`);
      return;
    }
    ctx.logger?.info?.(`dsh-notify: ${payload.kind} → ${record.sessionId} ${payload.title}`);
  };

  const report = async sessionId => {
    const record = records.get(sessionId);
    if (record === undefined) return;
    record.timer = null;
    const pendingKind = record.pendingKind;
    const detail = record.pendingDetail;
    clearPending(record);
    if (pendingKind === null) return;

    // The agent went idle, so its driver is done — but the *session* may still
    // have somewhere to be: an armed goal means a round driver will resume it.
    // Announcing a round as "finished" would be a lie the user acts on, so a
    // live goal defers; only its settlement is announced.
    const status = goalStatus(ctx, sessionId);
    if (status === 'active') {
      const deferred = isAttentionKind(pendingKind) ? pendingKind : null;
      if (deferred === null) return;
      await summarize(record);
      announce(record, deferred, detail);
      return;
    }
    if (status !== undefined) {
      const goalKind = notificationForGoal({ notifyOn: settings.notifyOn, status });
      if (goalKind === null) return;
      await summarize(record);
      announce(record, goalKind, '');
      return;
    }

    const kind = notificationForTurn({ notifyOn: settings.notifyOn, kind: pendingKind });
    if (kind === null) return;
    await summarize(record);
    announce(record, kind, detail);
  };

  /** Fill in the two session attributes a body is built from. */
  const summarize = async record => {
    if (!settings.includeSummary) return;
    record.title = await readTitle(ctx, record.sessionId, record.title);
    record.summary = await readLastAssistantText(ctx, record.sessionId);
  };

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    const sessionId = idOf(session);
    if (sessionId === undefined) return;
    const header = session?.header;
    if (header !== null && typeof header === 'object') {
      // A subagent's session is the agent's own business; the person waiting is
      // the parent session, whose notification covers it.
      if (settings.onlyMainSessions && header.origin === 'subagent') return;
      const record = stateFor(sessionId);
      if (typeof header.cwd === 'string' && header.cwd !== '') record.cwd = header.cwd;
    } else {
      stateFor(sessionId);
    }
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    const kind = kindForTurnEnd(data.reason);
    if (kind === null) return;
    const record = stateFor(sessionId);
    record.pendingKind = kind;
    record.pendingDetail = failureDetail(data.reason);
    record.pendingSeq = typeof event.seq === 'number' ? event.seq : -1;
  });

  ctx.on('agent/status', (payload, agent) => {
    const sessionId = idOf(agent) ?? idOf(payload?.agent);
    if (sessionId === undefined) return;
    const record = records.get(sessionId);
    if (record === undefined) return;
    if (payload?.status !== 'idle') {
      // The session picked the work back up before the delay elapsed, so the
      // recorded turn was a step of something still running. Nothing to say.
      cancel(record);
      clearPending(record);
      return;
    }
    if (!isPending(record)) return;
    cancel(record);
    record.timer = setTimeout(() => {
      record.timer = null;
      // Re-checked at fire time: between the idle transition and this timer a
      // new turn may have started, and its `turn/end` overwrites the record —
      // this guard is what keeps a continuation from being reported twice.
      if (!isPending(record)) return;
      void report(sessionId).catch(error => {
        ctx.logger?.warn?.(`dsh-notify: could not announce session ${sessionId} — ${describe(error)}`);
      });
    }, settings.settleDelayMs);
  });

  // The last moment a record can be dropped without leaking: once the session
  // left the live registry, no further event will name it.
  ctx.on('session/disposed', session => {
    const sessionId = idOf(session);
    if (sessionId === undefined) return;
    const record = records.get(sessionId);
    if (record === undefined) return;
    cancel(record);
    records.delete(sessionId);
  });

  ctx.logger?.info?.('dsh-notify: watching for finished tasks');
}

/** The host object every event and service lookup goes through. */
function idOf(value) {
  const id = value?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * The session's goal status, or undefined when it has none.
 *
 * Read optionally and defensively: `ctx.get` returns undefined for a service
 * this composition does not have, and a goal service that is missing, older, or
 * shaped differently must simply mean "no goal" — never a failed notification.
 */
function goalStatus(ctx, sessionId) {
  try {
    const goals = ctx.get('goals');
    if (goals === undefined || typeof goals.get !== 'function') return undefined;
    const agents = ctx.get('agents');
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent === undefined) return undefined;
    const view = goals.get(agent);
    const status = view?.goal?.status ?? view?.status;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}

async function readTitle(ctx, sessionId, fallback) {
  try {
    const query = ctx.get('sessionQuery');
    if (query === undefined || typeof query.readTitle !== 'function') return fallback;
    const snapshot = await query.readTitle(sessionId);
    const title = snapshot?.title;
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The assistant's last words, for the notification body.
 *
 * A surface read is preferred because it returns only what the model can
 * currently see instead of replaying a whole log to find one line; a session
 * with no surface yet falls back to the full read. `undefined` rather than an
 * empty string means "nothing to add", which `buildNotification` omits.
 */
async function readLastAssistantText(ctx, sessionId) {
  const query = ctx.get('sessionQuery');
  if (query === undefined) return undefined;
  try {
    if (typeof query.readSurface === 'function') {
      const snapshot = await query.readSurface(sessionId);
      const text = lastAssistantText(snapshot?.events);
      if (text !== undefined) return text;
    }
    if (typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId);
      return lastAssistantText(snapshot?.events);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function lastAssistantText(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join(' ')
      .trim();
    if (text !== '') return text;
  }
  return undefined;
}

/** A failure's message, for the body of a turn that ended in `error`. */
function failureDetail(reason) {
  const message = reason?.error?.message;
  return typeof message === 'string' ? message.trim() : '';
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
