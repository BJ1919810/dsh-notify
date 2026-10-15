/**
 * Tests for the decisions dsh-notify makes.
 *
 * These cover the rules a user is actually choosing between — when a toast is
 * allowed to appear, and what it says — because those are the parts that can be
 * wrong in a way nobody notices until they are annoyed. The Windows transport
 * itself is exercised by `scripts/smoke-toast.mjs`, which needs a real desktop.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTLE_DELAY_MAX_MS, normalize } from '../lib/config.js';
import {
  buildNotification,
  condense,
  isAttentionKind,
  kindForTurnEnd,
  notificationForGoal,
  notificationForTurn,
  truncate,
} from '../lib/format.js';

test('kindForTurnEnd maps the turn reasons the session log records', () => {
  assert.equal(kindForTurnEnd({ kind: 'completed' }), 'completed');
  assert.equal(kindForTurnEnd({ kind: 'blocked' }), 'blocked');
  assert.equal(kindForTurnEnd({ kind: 'interrupted' }), 'interrupted');
  assert.equal(kindForTurnEnd({ kind: 'forked' }), 'forked');
  assert.equal(kindForTurnEnd({ kind: 'max-tokens' }), 'max-tokens');
  assert.equal(kindForTurnEnd({ kind: 'error', error: { message: 'boom' } }), 'error');
});

test('kindForTurnEnd stays quiet only for a cancellation the user performed', () => {
  // The click that cancelled the turn was the interaction; a toast would be an
  // echo. Every other cancellation reason is something the user did not do.
  assert.equal(kindForTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), null);
  assert.equal(kindForTurnEnd({ kind: 'aborted', reason: { kind: 'parent' } }), 'aborted');
  assert.equal(kindForTurnEnd({ kind: 'aborted', reason: { kind: 'disposed' } }), 'aborted');
  assert.equal(kindForTurnEnd({ kind: 'aborted', reason: { kind: 'hook', reason: 'x' } }), 'aborted');
});

test('kindForTurnEnd survives a reason shape it does not know', () => {
  // A newer host adding a reason kind must produce a notification, not an
  // exception inside the agent loop.
  assert.equal(kindForTurnEnd({ kind: 'something-new' }), 'unknown');
  assert.equal(kindForTurnEnd(undefined), 'unknown');
  assert.equal(kindForTurnEnd('completed'), 'unknown');
});

test('condense flattens Markdown into a single readable line', () => {
  const markdown = [
    '# 修复完成',
    '',
    '改了 `lib/index.js`，并且：',
    '- 加了防护',
    '- 补了测试',
    '',
    '```js',
    'const notWritten = true;',
    '```',
    '',
    '见 [说明](https://example.com/docs)。',
  ].join('\n');
  const line = condense(markdown);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('```'), false);
  assert.equal(line.includes('const notWritten'), false);
  assert.equal(line.includes('修复完成'), true);
  assert.equal(line.includes('加了防护'), true);
  assert.equal(line.includes('见 说明。'), true);
});

test('truncate never splits a surrogate pair and marks what it cut', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('', 5), '');
  assert.equal(truncate('anything', 0), '');
  // '😀' is two UTF-16 units; a cut at the boundary must back off one.
  const emoji = '😀😀';
  const cut = truncate(emoji, 3);
  assert.equal(cut.endsWith('…'), true);
  assert.equal(cut.includes('\ufffd'), false);
  assert.equal(cut, '😀…');
});

test('buildNotification puts the outcome first and the summary after it', () => {
  const toast = buildNotification({
    kind: 'completed',
    title: '修复登录崩溃',
    cwd: 'C:\\work\\app',
    summary: '改了三个文件，测试通过。',
  });
  assert.equal(toast.title, '✅ 修复登录崩溃');
  assert.equal(toast.body, '改了三个文件，测试通过。');
  assert.equal(toast.sound, 'Default');
});

test('buildNotification names the failure when a turn ended in error', () => {
  const toast = buildNotification({
    kind: 'error',
    title: '构建',
    detail: 'connect ETIMEDOUT 443',
    summary: '先试着重试。',
  });
  assert.equal(toast.title, '❌ 构建');
  assert.equal(toast.body.startsWith('connect ETIMEDOUT 443'), true);
  assert.equal(toast.sound, 'Reminder');
});

test('buildNotification falls back to the directory, and only mentions it once', () => {
  const withoutTitle = buildNotification({
    kind: 'completed',
    cwd: 'C:\\work\\app',
    includeCwd: true,
  });
  assert.equal(withoutTitle.title, '✅ C:\\work\\app');
  assert.equal(withoutTitle.body, '');

  const withTitle = buildNotification({
    kind: 'completed',
    title: '修复登录崩溃',
    cwd: 'C:\\work\\app',
    includeCwd: true,
  });
  assert.equal(withTitle.title, '✅ 修复登录崩溃');
  assert.equal(withTitle.body, 'C:\\work\\app');
});

test('buildNotification has a title even when nothing else is known', () => {
  const toast = buildNotification({ kind: 'unknown' });
  assert.equal(toast.title, '🔔 DSH');
  assert.equal(toast.body, '');
});

test('buildNotification respects the summary budget', () => {
  const toast = buildNotification({
    kind: 'completed',
    summary: 'x'.repeat(500),
    bodyLimit: 50,
  });
  assert.equal(toast.body.length, 51); // 50 characters plus the ellipsis
  assert.equal(toast.body.endsWith('…'), true);
});

test('notificationForTurn reports a plain turn and stays quiet for a cancelled one', () => {
  const base = { notifyOn: 'every-turn' };
  assert.equal(notificationForTurn({ ...base, kind: 'completed' }), 'completed');
  assert.equal(notificationForTurn({ ...base, kind: 'error' }), 'error');
  assert.equal(notificationForTurn({ ...base, kind: null }), null);
  assert.equal(notificationForTurn({ ...base, kind: 'completed', notifyOn: 'never' }), null);
});

test('notificationForTurn silences by category, and only by category', () => {
  // Whether a *live goal* should defer its rounds is deliberately not decided
  // here: that needs the goal status read when the announcement fires, not when
  // the turn ended.
  assert.equal(notificationForTurn({ notifyOn: 'attention', kind: 'completed' }), null);
  assert.equal(notificationForTurn({ notifyOn: 'attention', kind: 'max-tokens' }), null);
  assert.equal(notificationForTurn({ notifyOn: 'attention', kind: 'error' }), 'error');
  assert.equal(notificationForTurn({ notifyOn: 'attention', kind: 'blocked' }), 'blocked');
  assert.equal(notificationForTurn({ notifyOn: 'attention', kind: 'attention' }), 'attention');
  assert.equal(notificationForTurn({ notifyOn: 'never', kind: 'error' }), null);
  assert.equal(notificationForTurn({ notifyOn: 'never', kind: 'blocked' }), null);
});

test('isAttentionKind names exactly the outcomes that need a person', () => {
  assert.equal(isAttentionKind('attention'), true);
  assert.equal(isAttentionKind('blocked'), true);
  assert.equal(isAttentionKind('error'), true);
  assert.equal(isAttentionKind('completed'), false);
  assert.equal(isAttentionKind('max-tokens'), false);
  assert.equal(isAttentionKind(undefined), false);
});

test('notificationForGoal announces the two statuses that end a goal', () => {
  assert.equal(notificationForGoal({ notifyOn: 'every-turn', status: 'complete' }), 'goal');
  assert.equal(notificationForGoal({ notifyOn: 'every-turn', status: 'blocked' }), 'blocked');
  // Paused and cleared are the user's own clicks; a toast would echo them.
  assert.equal(notificationForGoal({ notifyOn: 'every-turn', status: 'paused' }), null);
  assert.equal(notificationForGoal({ notifyOn: 'every-turn', status: 'cleared' }), null);
  assert.equal(notificationForGoal({ notifyOn: 'never', status: 'complete' }), null);
  assert.equal(notificationForGoal({ notifyOn: 'attention', status: 'complete' }), null);
});

test('normalize fills a usable configuration from nothing', () => {
  const settings = normalize(undefined);
  assert.equal(settings.enabled, true);
  assert.equal(settings.notifyOn, 'every-turn');
  assert.equal(settings.onlyMainSessions, true);
  assert.equal(settings.settleDelayMs, 400);
  assert.equal(settings.includeSummary, true);
  assert.equal(settings.includeCwd, false);
  assert.equal(settings.summaryLimit, 220);
  assert.equal(settings.sound, 'kind');
  assert.equal(settings.appId, '');
});

test('normalize refuses values a hand-edited profile could contain', () => {
  const settings = normalize({
    enabled: 'yes',
    notifyOn: 'sometimes',
    settleDelayMs: -5,
    summaryLimit: 99_999,
    sound: 'NotASound',
    appId: 42,
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.notifyOn, 'every-turn');
  assert.equal(settings.settleDelayMs, 0);
  assert.equal(settings.summaryLimit, 1000);
  assert.equal(settings.sound, 'kind');
  assert.equal(settings.appId, '');
});

test('normalize keeps clamping the delay to the supported maximum', () => {
  assert.equal(normalize({ settleDelayMs: SETTLE_DELAY_MAX_MS + 1 }).settleDelayMs, SETTLE_DELAY_MAX_MS);
  assert.equal(normalize({ settleDelayMs: '250' }).settleDelayMs, 250);
});
