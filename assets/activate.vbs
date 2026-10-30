' dsh-notify activation handler.
'
' Windows invokes this through the `dshnotify:` URI scheme registered by
' scripts/install-activation.ps1, passing the clicked toast's launch URI as the
' first argument: `dshnotify:<sessionId>`.
'
' Order matters here, and it is the opposite of what it looks like it should be:
'
'   1. POST the session id first (one WinHttp call, ~50 ms). The browser half
'      polls the receiver and switches the conversation as soon as it sees it.
'   2. Raise the window afterwards. Raising it fires the page's focus event,
'      which makes the browser half poll *immediately* — so by the time the
'      window is in front it already shows the right conversation. Doing it the
'      other way round shows the previous conversation for a second before it
'      jumps, which is exactly what a click should never do.
'
' Raising is done by assets\focus.exe (a few milliseconds, compiled at install
' time). AppActivate is the fallback — fast, but it will not restore a minimised
' window — and PowerShell the last resort: reliable, but ~2 s to start.
'
' wscript (not cscript) runs this without a console window, and the shell is
' told to start the helper hidden for the same reason: a toast click must not
' flash a black window at the person who clicked it.
Option Explicit

Dim shell, fso, here, uri, sessionId, port, posted, raised, handled

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' The handler runs hidden, so a failure is invisible: every click leaves one
' line in %LOCALAPPDATA%\dsh-notify\activate.log to tell "never ran" from
' "ran and did not raise" when someone reports a dead click.
Dim logFile
logFile = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\dsh-notify\activate.log"
Sub LogLine(text)
  On Error Resume Next
  Dim folder, stream
  folder = fso.GetParentFolderName(logFile)
  If Not fso.FolderExists(folder) Then fso.CreateFolder folder
  Set stream = fso.OpenTextFile(logFile, 8, True)
  stream.WriteLine Now & " " & text
  stream.Close
  Err.Clear
End Sub

uri = ""
If WScript.Arguments.Count > 0 Then uri = WScript.Arguments(0)

' The argument arrives from the registry command line, so it is untrusted input:
' any process can shell-execute a dshnotify: URI. A session id is a narrow,
' known character set, so anything else is dropped instead of being pasted into
' a command line or a URL below.
sessionId = ""
LogLine "start uri=" & uri
If Len(uri) > 0 And Len(uri) <= 300 Then
  Dim re, match
  Set re = New RegExp
  re.Pattern = "^([A-Za-z][A-Za-z0-9+.\-]*):([A-Za-z0-9][A-Za-z0-9._\-]*)$"
  Set match = re.Execute(uri)
  If match.Count = 1 Then sessionId = match(0).SubMatches(1)
End If

' Settings written by scripts/install-activation.ps1; the defaults match the
' plugin's own defaults so a hand-installed copy still works.
port = 5178
Dim settingsPath, raw, portRe, portMatch
settingsPath = here & "\activation.json"
If fso.FileExists(settingsPath) Then
  raw = ""
  On Error Resume Next
  raw = fso.OpenTextFile(settingsPath, 1).ReadAll
  Err.Clear
  On Error GoTo 0
  Set portRe = New RegExp
  portRe.Pattern = """port""\s*:\s*(\d+)"
  Set portMatch = portRe.Execute(raw)
  If portMatch.Count = 1 Then port = CLng(portMatch(0).SubMatches(0))
End If

' 1. Hand the id over before anything slow happens.
posted = False
If Len(sessionId) > 0 Then
  On Error Resume Next
  Dim http
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.SetTimeouts 300, 300, 500, 1500
  http.Open "GET", "http://127.0.0.1:" & port & "/activate?s=" & sessionId, False
  http.Send
  posted = (Err.Number = 0)
  LogLine "post id=" & sessionId & " posted=" & posted & " err=" & Err.Number
  Err.Clear
  On Error GoTo 0
End If

' 2. Raise the window, cheapest reliable path first.
raised = False
handled = False
Dim focusExe, rc
focusExe = here & "\focus.exe"
If fso.FileExists(focusExe) Then
  On Error Resume Next
  rc = shell.Run(Chr(34) & focusExe & Chr(34), 0, True)
  If Err.Number = 0 Then
    raised = (rc = 0)
    ' rc 3: the window is hidden by the app (tray). Raising it from outside is
    ' undone by Chromium, so focus.exe deliberately leaves it alone: the session
    ' id is already delivered and the window opens on the right conversation
    ' once the app brings itself back. That is handled, not a failure.
    handled = (rc = 0 Or rc = 3)
  End If
  LogLine "focus rc=" & rc & " raised=" & raised & " handled=" & handled & " err=" & Err.Number
  Err.Clear
  On Error GoTo 0
End If

If Not raised Then
  On Error Resume Next
  Dim services, processes, process, pid
  Set services = GetObject("winmgmts:\\.\root\cimv2")
  Set processes = services.ExecQuery("Select ProcessId from Win32_Process Where Name='DeepSeek Harness.exe'")
  For Each process In processes
    pid = process.ProcessId
    If shell.AppActivate(pid) Then
      raised = True
      Exit For
    End If
  Next
  Err.Clear
  On Error GoTo 0
End If

' Last resort: PowerShell restores minimised windows and re-sends the id, so a
' failure above still ends up opening the session.
LogLine "fallback needed=" & ((Not handled) Or (Not posted))
If (Not handled) Or (Not posted) Then
  shell.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " _
    & Chr(34) & here & "\activate.ps1" & Chr(34) & " " & Chr(34) & uri & Chr(34), 0, False
End If
