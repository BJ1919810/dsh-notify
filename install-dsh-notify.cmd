@echo off
rem One-click local install / uninstall for dsh-notify.
rem
rem Double-click this file with DSH QUIT (not just the window closed). A live
rem host rewrites the profile from its in-memory composition, so an edit made
rem while it is running is silently reverted.
rem
rem What it does:
rem   1. finds the Node that DSH itself ships (node is not on PATH here)
rem   2. links this folder into the profile's node_modules
rem   3. adds "dsh-notify" to the profile's dsh.profile.bundles -- the ONLY
rem      correct way to load a new plugin; a bare "- id:" row in
rem      cordis.patch.yml has no target and takes the whole boot down
rem   4. backs up package.json and re-parses the result before writing
rem
rem Undo: run this file with the argument:  remove
rem
rem This file is deliberately ASCII-only: a .cmd with Chinese comments renders
rem as mojibake under the machine's GBK code page (chcp 936).

setlocal EnableExtensions
set "HERE=%~dp0"
set "ACTION=enable"
if /I "%~1"=="remove" set "ACTION=disable"
if /I "%~1"=="disable" set "ACTION=disable"

set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "SCRIPT=%HERE%scripts\set-bundle-state.mjs"
set "PROFILE=%USERPROFILE%\.dsh\profiles\desktop"

if not exist "%NODE%" (
  echo.
  echo   Could not find the Node that DSH ships at:
  echo     %NODE%
  echo   Run this instead with any node on PATH:
  echo     node "%SCRIPT%" --name dsh-notify --action %ACTION%
  echo.
  pause
  exit /b 2
)
if not exist "%SCRIPT%" (
  echo.
  echo   Missing %SCRIPT%
  echo   Run this file from inside the dsh-notify folder.
  echo.
  pause
  exit /b 2
)

echo.
echo   dsh-notify local %ACTION%
echo   ================================
echo   profile: %PROFILE%
echo.

rem --link: a name in dsh.profile.bundles is a promise that the loader can
rem import it, so the package also has to be resolvable from the profile. The
rem first version of this only wrote the bundles row, which left the boot
rem unable to resolve the plugin.
"%NODE%" "%SCRIPT%" --name dsh-notify --action %ACTION% --profile "%PROFILE%" --link "%HERE%."
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  if /I "%ACTION%"=="enable" (
    echo   Done. Now START DeepSeek Harness and run any task --
    echo   when the task really finishes, a Windows notification appears.
    echo   In goal mode only the goal's own completion notifies, by design.
  ) else (
    echo   Done. dsh-notify removed from the profile.
  )
) else (
  echo   Nothing was changed ^(exit %CODE%^). Read the message above.
  echo   The usual cause: DSH is still running. Quit it completely and retry.
)
echo.
pause
