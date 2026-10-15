/**
 * Everything dsh-notify decides, with no I/O: what a finished turn is called,
 * whether it is worth a notification, what the notification says, and when the
 * summary is too long to be read on a lock screen.
 *
 * The host-facing module (`index.js`) holds only wiring, so the rules that
 * decide whether a person gets interrupted can be read and tested on their own.
 */

/** Notification kinds, ordered from "finished well" to "needs a human". */
export const KINDS = Object.freeze({
  completed: { label: '已完成', symbol: '✅' },
  attention: { label: '等待回答', symbol: '❓' },
  blocked: { label: '已阻塞', symbol: '⏸️' },
  interrupted: { label: '已中断', symbol: '⏹️' },
  aborted: { label: '已取消', symbol: '⏹️' },
  forked: { label: '已分叉', symbol: '🔀' },
  'max-tokens': { label: '已达上限', symbol: '📏' },
  error: { label: '出错', symbol: '❌' },
  goal: { label: '目标完成', symbol: '🎯' },
  unknown: { label: '已结束', symbol: '🔔' },
});

export const DEFAULT_SOUNDS = Object.freeze({
  completed: 'Default',
  attention: 'Reminder',
  blocked: 'Reminder',
  interrupted: 'Default',
  aborted: 'Default',
  forked: 'Default',
  'max-tokens': 'Default',
  error: 'Reminder',
  goal: 'Default',
  unknown: 'Default',
});

/** Kinds that mean the agent stopped and a person is what it is waiting for. */
const ATTENTION_KINDS = new Set(['attention', 'blocked', 'error']);

/** Whether this kind is one a person has to act on. */
export function isAttentionKind(kind) {
  return ATTENTION_KINDS.has(kind);
}

/**
 * Map a durable `turn/end` reason onto a notification kind.
 *
 * The reason objects come from the session log's `TurnEndReasonMap` and are
 * deliberately read defensively: a newer host may add a `kind`, and an unknown
 * one must still produce a notification rather than an exception inside the
 * agent loop.
 */
export function kindForTurnEnd(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined;
  switch (kind) {
    case 'completed':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'interrupted':
      return 'interrupted';
    case 'forked':
      return 'forked';
    case 'max-tokens':
      return 'max-tokens';
    case 'error':
      return 'error';
    case 'aborted': {
      // A turn the user cancelled themselves needs no announcement: the click
      // that cancelled it was the interaction. A turn cancelled for any other
      // reason (a parent, a teardown, a hook) does.
      const cause = reason.reason && typeof reason.reason === 'object' ? reason.reason.kind : undefined;
      if (cause === 'user') return null;
      return cause === undefined ? null : 'aborted';
    }
    default:
      return 'unknown';
  }
}

/** Describe a finished turn in the words shown on the toast. */
export function labelFor(kind, { attention = false } = {}) {
  if (kind === 'completed' && attention) return KINDS.attention;
  return KINDS[kind] ?? KINDS.unknown;
}

/**
 * Fold whitespace the way a one-line toast needs it: a summary is a fragment
 * of Markdown, so headings, bullets, fenced blocks, tables and wrapping all have
 * to collapse before it can be read on a lock screen.
 *
 * Tables get their own treatment because a summary that ends with one is common
 * — the model reaches for a table exactly when summarising a comparison — and
 * leaving the syntax in produces a notification that reads like
 * `| a | b | | --- | --- |`. Only the separator row is dropped outright; cell
 * dividers become ordinary spaces so the words survive in reading order.
 */
export function condense(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // A table's alignment row (`| --- | :--: |`) carries no words at all.
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cut a summary to `limit` characters without splitting a surrogate pair, and
 * say so, so a truncated line is never mistaken for the whole answer.
 */
export function truncate(text, limit) {
  const value = String(text ?? '');
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  let end = limit;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

/**
 * Build the final toast text.
 *
 * @param {object} input
 * @param {string} input.kind - notification kind.
 * @param {string} [input.title] - session title, when the host has one.
 * @param {string} [input.cwd] - working directory, for telling sessions apart.
 * @param {string} [input.summary] - the assistant's last words.
 * @param {boolean} [input.attention] - the agent is waiting for a person.
 * @param {string} [input.detail] - a failure message or block reason.
 * @param {boolean} [input.includeCwd] - whether the directory belongs in the title.
 * @param {number} [input.titleLimit] - maximum title length.
 * @param {number} [input.bodyLimit] - maximum body length.
 */
export function buildNotification(input) {
  const {
    kind,
    title,
    cwd,
    summary,
    attention = false,
    detail,
    includeCwd = false,
    titleLimit = 96,
    bodyLimit = 220,
  } = input;

  const description = labelFor(kind, { attention });
  const head = [];
  const sessionName = truncate(condense(title), titleLimit);
  if (sessionName) head.push(sessionName);
  else if (includeCwd) head.push(truncate(condense(cwd), titleLimit));
  const toastTitle = `${description.symbol} ${head.join(' · ') || 'DSH'}`;

  const parts = [];
  const reason = truncate(condense(detail), bodyLimit);
  if (reason) parts.push(reason);
  const text = truncate(condense(summary), Math.max(0, bodyLimit - (reason ? reason.length + 3 : 0)));
  if (text) parts.push(text);
  if (includeCwd && sessionName) {
    const directory = truncate(condense(cwd), 80);
    if (directory) parts.push(directory);
  }

  return {
    kind,
    label: description.label,
    title: toastTitle,
    body: parts.join(' — '),
    sound: DEFAULT_SOUNDS[kind] ?? DEFAULT_SOUNDS.unknown,
    attention: attention || ATTENTION_KINDS.has(kind),
  };
}

/**
 * Whether this finished turn is allowed to become a notification at all.
 *
 * Only the two settings that silence a category live here. Whether a *running*
 * goal should defer its rounds is a separate question, asked later by the host
 * module, because answering it needs the goal's status read at the moment the
 * announcement would fire — not at the moment the turn ended.
 *
 * @returns {string | null} the notification kind, or null for "stay quiet".
 */
export function notificationForTurn({ notifyOn, kind }) {
  if (kind === null || kind === undefined) return null;
  if (notifyOn === 'never') return null;
  if (notifyOn === 'attention') return ATTENTION_KINDS.has(kind) ? kind : null;
  return kind;
}

/**
 * Whether a goal's settlement should be announced.
 *
 * `complete` and `blocked` end the goal; `paused` and `cleared` are things the
 * user just did in the GUI, so announcing them would only echo their own click.
 */
export function notificationForGoal({ notifyOn, status }) {
  if (notifyOn === 'never') return null;
  if (status === 'blocked') return 'blocked';
  if (status === 'complete') return notifyOn === 'attention' ? null : 'goal';
  return null;
}
