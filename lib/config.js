/**
 * Configuration normalization for dsh-notify.
 *
 * The Config schema already applies these defaults, so this exists for the
 * case the schema cannot cover: a value written by hand into the profile's
 * `cordis.patch.yml`, or a newer host that omits a key. A notification plugin
 * must never be the reason a host fails to boot, so every field is coerced
 * back into range instead of trusted.
 */

export const NOTIFY_ON = ['every-turn', 'attention', 'never'];

export const SETTLE_DELAY_MAX_MS = 120_000;

/** Sounds the WinRT toast API accepts; `kind` and `silent` are added by the schema. */
export const SOUNDS = [
  'Default',
  'Reminder',
  'IM',
  'Mail',
  'SMS',
  'Alarm',
  'Alarm2',
  'Alarm3',
  'Alarm4',
  'Alarm5',
  'Alarm6',
  'Alarm7',
  'Alarm8',
  'Alarm9',
  'Alarm10',
  'Call',
  'Call2',
  'Call3',
  'Call4',
  'Call5',
  'Call6',
  'Call7',
  'Call8',
  'Call9',
  'Call10',
];

export const SOUND_ALIASES = new Set(['kind', 'silent', ...SOUNDS]);

/**
 * Apply defaults and clamp values a hand-edited config could get wrong.
 *
 * @param {unknown} config - the raw config the loader passed to `apply`.
 * @returns {object} a value every later decision can rely on.
 */
export function normalize(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const integer = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  return {
    enabled: raw.enabled !== false,
    notifyOn: NOTIFY_ON.includes(raw.notifyOn) ? raw.notifyOn : 'every-turn',
    onlyMainSessions: raw.onlyMainSessions !== false,
    settleDelayMs: integer(raw.settleDelayMs, 400, 0, SETTLE_DELAY_MAX_MS),
    includeSummary: raw.includeSummary !== false,
    includeCwd: raw.includeCwd === true,
    summaryLimit: integer(raw.summaryLimit, 220, 0, 1000),
    sound: SOUND_ALIASES.has(raw.sound) ? raw.sound : 'kind',
    appId: typeof raw.appId === 'string' ? raw.appId.trim() : '',
    // Off by default on purpose: activation needs a registry entry installed for
    // the URI scheme (scripts/install-activation.cmd), so a plugin that has not
    // been asked to do that must not open a listening socket either.
    activate: raw.activate === true,
    activationPort: integer(raw.activationPort, 5178, 1024, 65_535),
    activationScheme:
      typeof raw.activationScheme === 'string' && /^[a-z][a-z0-9+.-]{1,30}$/.test(raw.activationScheme.trim().toLowerCase())
        ? raw.activationScheme.trim().toLowerCase()
        : 'dshnotify',
    // Off by default: this is a diagnostic, not a feature. It exists because a
    // notification that does not arrive is invisible — there is no UI to look
    // at, and the host's log is the only place a decision can be observed.
    debug: raw.debug === true,
  };
}
