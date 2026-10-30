/**
 * Windows toast transport for dsh-notify.
 *
 * A Windows notification is delivered by the WinRT toast API, which is only
 * reachable through PowerShell: Node has no supported binding for
 * `Windows.UI.Notifications`. This module therefore owns exactly one thing —
 * turning a title/body pair into a visible toast — and keeps every decision
 * that is worth testing out of it (see `format.js`).
 *
 * Two properties matter for a plugin that runs inside somebody else's host:
 *
 * 1. Nothing about a session's text reaches a command line. A title or body
 *    can contain quotes, newlines, `$`, backticks or `;`, and any of those
 *    would change the meaning of a command string. Instead the text is handed
 *    over on the child's stdin and in its environment, and the script template
 *    itself is a fixed constant with no interpolation point. There is no shell
 *    string to escape, which is why there is no escaping code here.
 * 2. The toast is shown out of process and never awaited by the caller. The
 *    agent turn that triggered it must close at the same speed whether or not a
 *    notification was sent, so the outcome only ever fills a log line. The
 *    child is deliberately *not* detached or unref'd: a notification is a few
 *    hundred milliseconds of work, and an unreferenced child is one the host
 *    cannot see finish — which turns a failed toast into a silent one.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `powershell.exe` (Windows PowerShell 5.1) rather than `pwsh`: 5.1 ships with
 * every supported Windows and, unlike PowerShell 7, needs no apartment-state
 * workaround for the WinRT type resolver. A host launched without a useful
 * PATH still finds it, because it is an absolute path.
 */
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Where the script template is written once per process.
 *
 * `-Command -` (read the program from stdin) is the obvious way to keep a
 * script out of the command line, but it is not reliable: `powershell.exe`
 * treats the first stdin line as a *command*, so the script's own first line is
 * executed as a cmdlet name and fails. A file passed to `-File` has neither
 * problem — the command line stays free of session text, and the program is
 * parsed as a program.
 *
 * The path is written once and removed on exit. Nothing from a session is
 * interpolated into it: the file is the constant template, and session text
 * travels on stdin.
 */
let scriptPath;

export function materializedScript(env = process.env) {
  if (scriptPath !== undefined) return scriptPath;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-'));
  const file = join(dir, 'toast.ps1');
  writeFileSync(file, SCRIPT_TEMPLATE, 'utf8');
  scriptPath = file;
  const cleanup = () => {
    scriptPath = undefined;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp file is not worth failing a host shutdown over; the OS
      // clears its own temp directory.
    }
  };
  process.once('exit', cleanup);
  return file;
}

/** Test seam: forget the materialized script between cases. */
export function resetScriptCache() {
  scriptPath = undefined;
}

/**
 * The script template.
 *
 * Every value that comes from a session is XML-escaped with
 * `[SecurityElement]::Escape`, and the AppUserModelID goes into a
 * single-quoted PowerShell literal with `'` doubled. Those are the only two
 * places a session value could change the program, and both are closed.
 *
 * Session text itself never reaches this string: it is read from the
 * environment and stdin, so the template stays a constant.
 */
const SCRIPT_TEMPLATE = `$ErrorActionPreference = 'Stop'
# Windows PowerShell would write its error stream in the machine's ANSI code
# page, which on a Chinese Windows is GBK. Pin it to UTF-8 so the one channel
# this plugin captures is readable on every locale.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$appId = '__APP_ID__'
# The URI a click activates. Empty keeps the historical behaviour (the identity
# string, which ShellExecute cannot launch) so a machine without the activation
# handler installed loses nothing it used to have.
$launch = ''
$title = $env:DSH_NOTIFY_TITLE
$body = $env:DSH_NOTIFY_BODY
$image = $env:DSH_NOTIFY_IMAGE
$silent = ($env:DSH_NOTIFY_SILENT -eq '1')
$options = @{}
$rest = @()
# Text is carried as pure ASCII with non-ASCII characters written as \\uXXXX
# escapes, and decoded here. Windows PowerShell reads its standard input through
# the console code page, so raw UTF-8 bytes would arrive as mojibake — a Chinese
# session title rendered as question-mark soup. An ASCII-only wire format cannot
# be mangled by whichever code page the machine happens to use, so this decoder
# is what makes the transport locale-independent.
$decode = {
  param([string]$text)
  if ([string]::IsNullOrEmpty($text)) { return '' }
  $sb = [System.Text.StringBuilder]::new()
  $i = 0
  while ($i -lt $text.Length) {
    if ($text[$i] -eq '\\' -and ($i + 5) -lt $text.Length -and $text[$i + 1] -eq 'u') {
      $hex = $text.Substring($i + 2, 4)
      $code = 0
      if ([int]::TryParse($hex, [System.Globalization.NumberStyles]::HexNumber, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$code)) {
        [void]$sb.Append([char]$code)
        $i += 6
        continue
      }
    }
    [void]$sb.Append($text[$i])
    $i += 1
  }
  return $sb.ToString()
}
foreach ($line in @($input)) {
  $text = [string]$line
  if ($text.StartsWith('sound=')) { $options.sound = [string]$text.Substring(6) }
  elseif ($text.StartsWith('icon=')) { $options.icon = [string]$text.Substring(5) }
  elseif ($text.StartsWith('appId=')) { $appId = [string]$text.Substring(6) }
  elseif ($text.StartsWith('launch=')) { $launch = & $decode ([string]$text.Substring(7)) }
  elseif ($text.StartsWith('title=')) { $title = & $decode ([string]$text.Substring(6)) }
  elseif ($text.StartsWith('body=')) { $body = & $decode ([string]$text.Substring(5)) }
  else { $rest += , $text }
}
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
# The click target. activationType="protocol" makes Windows ShellExecute this
# string, so it has to be a URI: an empty launch falls back to the app id,
# which is not one and therefore does nothing — the pre-activation behaviour.
$target = if ([string]::IsNullOrEmpty($launch)) { $appId } else { $launch }
# A toast with no title line is malformed, so the app id stands in for one.
if ([string]::IsNullOrEmpty($title)) { $title = $appId }
$visual = '<text>' + [System.Security.SecurityElement]::Escape($title) + '</text>'
if (-not [string]::IsNullOrEmpty($body)) {
  $visual += '<text>' + [System.Security.SecurityElement]::Escape($body) + '</text>'
}
$imageXml = ''
# Null-tested with [string]::IsNullOrEmpty, not with a not-equal-to-empty-string
# comparison: in Windows PowerShell 5.1 an empty string literal in an expression
# behaves as an empty array, so that comparison is TRUE for an empty $image.
# Under $ErrorActionPreference = 'Stop' the Test-Path below then threw and cost
# the entire toast — which is exactly what an unset icon used to do.
if (-not [string]::IsNullOrEmpty($image) -and (Test-Path -LiteralPath $image -ErrorAction SilentlyContinue)) {
  $imageXml = '<image placement="appLogoOverride" hint-crop="circle" src="' + [System.Security.SecurityElement]::Escape($image) + '"/>'
}
$audioXml = ''
if ($silent) { $audioXml = '<audio silent="true"/>' }
elseif ($options.ContainsKey('sound')) {
  $sound = [string]$options.sound
  if (-not [string]::IsNullOrEmpty($sound) -and $sound -ne 'silent' -and $sound -ne 'default') {
    $audioXml = '<audio src="ms-winsoundevent:Notification.' + [System.Security.SecurityElement]::Escape($sound) + '"/>'
  }
}
$xml = '<toast activationType="protocol" launch="' + [System.Security.SecurityElement]::Escape($target) + '"><visual><binding template="ToastGeneric">' + $visual + $imageXml + '</binding></visual>' + $audioXml + '</toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

/**
 * Fallback AppUserModelID. A desktop shortcut owns the real DSH identity and
 * the launcher can pass it in as `DSH_APP_USER_MODEL_ID`; under a plain
 * `dsh web` this is the identity PowerShell itself registers, so the toast
 * appears under a known name instead of being dropped silently.
 */
export const FALLBACK_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Coerce whatever the environment offers into a usable AppUserModelID. */
export function resolveAppId(env = process.env) {
  const value = env.DSH_APP_USER_MODEL_ID;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : FALLBACK_APP_ID;
}

let cachedImage;

/**
 * The image shown as the toast's app-logo override.
 *
 * A toast only accepts a local path, and the candidates are icons this machine
 * already has — not shipped copies, because a 256px icon would be the largest
 * thing in the package for a decorative effect.
 */
export function resolveIcon(candidates = defaultIconCandidates(), exists = existsSync) {
  if (cachedImage !== undefined) return cachedImage;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      if (exists(candidate)) {
        cachedImage = candidate;
        return cachedImage;
      }
    } catch {
      // A candidate we cannot probe is simply not a candidate.
    }
  }
  cachedImage = '';
  return cachedImage;
}

function defaultIconCandidates(env = process.env) {
  const candidates = [];
  const execPath = process.execPath;
  if (typeof execPath === 'string' && execPath !== '') {
    const separator = Math.max(execPath.lastIndexOf('\\'), execPath.lastIndexOf('/'));
    const dir = separator > 0 ? execPath.slice(0, separator) : '';
    if (dir !== '') {
      for (const name of ['icon.png', 'tray.ico', 'app.ico', 'icon.ico']) candidates.push(`${dir}\\${name}`);
    }
  }
  const resources = env.DSH_APP_RESOURCES_DIR;
  if (typeof resources === 'string' && resources !== '') candidates.push(join(resources, 'icon.png'));
  return candidates;
}

/** Test seam: forget the memoized icon between cases. */
export function resetIconCache() {
  cachedImage = undefined;
}

/**
 * Escape everything outside printable ASCII as `\uXXXX`.
 *
 * This is the wire format for the child, and it exists because Windows
 * PowerShell reads standard input through the console code page: raw UTF-8
 * bytes come back as mojibake on any machine whose ANSI code page is not UTF-8,
 * which is most of them. ASCII survives every code page, and the script decodes
 * the escapes back into text.
 *
 * Control characters are escaped too — a title with a newline in it would
 * otherwise split one field into two and quietly corrupt the message.
 */
export function encodeField(value) {
  const text = String(value ?? '');
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e && character !== '\\') {
      out += character;
      continue;
    }
    if (code > 0xffff) {
      // Outside the BMP: send the surrogate pair, which is what the child's
      // UTF-16 string is made of anyway.
      for (let index = 0; index < character.length; index += 1) {
        out += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/**
 * Shape the stdin protocol the template consumes: one `key=value` line per
 * field, values ASCII-escaped. A title that happens to look like `sound=…`
 * cannot be read as an option, because the script only matches a line's
 * prefix and the caller's text is written last, under a fixed key.
 */
export function buildStdin({ appId, title, body, silent, sound, icon, launch }) {
  const lines = [`appId=${appId}`, `title=${encodeField(title)}`, `body=${encodeField(body)}`];
  if (launch) lines.push(`launch=${encodeField(launch)}`);
  if (sound) lines.push(`sound=${sound}`);
  if (icon) lines.push(`icon=${encodeField(icon)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Show one toast. Resolves as soon as the child is spawned; `outcome` reports
 * what the child later did, for logging only — the caller must not wait on it.
 *
 * @returns {{ pid: number | undefined, outcome: Promise<{ ok: boolean, reason?: string }> }}
 */
export function showToast(options, { spawnImpl = spawn, env = process.env } = {}) {
  const appId = typeof options.appId === 'string' && options.appId.trim() !== '' ? options.appId.trim() : resolveAppId(env);
  const title = String(options.title ?? '');
  const body = String(options.body ?? '');
  const image = resolveIcon();

  let child;
  try {
    child = spawnImpl(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', materializedScript()],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...env,
          DSH_NOTIFY_TITLE: title,
          DSH_NOTIFY_BODY: body,
          DSH_NOTIFY_IMAGE: image,
          DSH_NOTIFY_SILENT: options.silent ? '1' : '',
        },
      },
    );
  } catch (error) {
    return { pid: undefined, outcome: Promise.resolve({ ok: false, reason: describe(error) }) };
  }

  const outcome = new Promise(resolve => {
    const decoder = new TextDecoder(powershellEncoding());
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(result);
    };
    // PowerShell starts in a few hundred milliseconds. The guard is not a
    // performance budget — it is what keeps a wedged child from leaving this
    // promise pending forever inside the host's process.
    const guard = setTimeout(() => finish({ ok: false, reason: 'powershell did not exit in time' }), 15000);
    guard.unref?.();
    child.once('error', error => finish({ ok: false, reason: describe(error) }));
    child.stderr?.on('data', chunk => {
      if (stderr.length < 4096) stderr += decoder.decode(chunk, { stream: true });
    });
    child.once('close', code => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, reason: firstLine(stderr) || `powershell exited with code ${code}` });
    });
    try {
      child.stdin?.on('error', () => {});
      child.stdin?.setDefaultEncoding?.('utf8');
      child.stdin?.end(buildStdin({ appId, title, body, silent: options.silent, sound: options.sound, icon: image, launch: options.launch }));
    } catch (error) {
      finish({ ok: false, reason: describe(error) });
    }
  });

  return { pid: child.pid, outcome };
}

/**
 * The encoding PowerShell writes to a redirected stderr.
 *
 * The template pins `[Console]::OutputEncoding` to UTF-8, so that is what this
 * reads whenever the script got far enough to run it. When it did not — a
 * spawn failure, or an execution-policy refusal before the first line — the
 * text is either Node's own ASCII message or the machine's ANSI code page, and
 * an override is the escape hatch for a locale where that guess is wrong.
 */
function powershellEncoding() {
  const override = process.env.DSH_NOTIFY_OUTPUT_ENCODING;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return 'utf-8';
}

/** Whether a toast can plausibly be delivered from this process at all. */
export function transportAvailability({ platform = process.platform, exists = existsSync } = {}) {
  if (platform !== 'win32') return { ok: false, reason: `Windows notifications require win32, not ${platform}` };
  if (!exists(POWERSHELL)) return { ok: false, reason: `Windows PowerShell not found at ${POWERSHELL}` };
  return { ok: true };
}

export { POWERSHELL, SCRIPT_TEMPLATE };

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function firstLine(text) {
  const line = String(text ?? '')
    .trim()
    .split(/\r?\n/)
    .find(entry => entry.trim() !== '');
  return line ? line.trim().slice(0, 300) : '';
}
