# Tab Thrashing setup for Windows.
#   Double-click setup.cmd, or run:  powershell -ExecutionPolicy Bypass -File setup.ps1
# Options:
#   -Autostart          start the server automatically when you sign in (no prompt)
#   -RemoveAutostart    undo -Autostart and exit
#   -NoStart            set up only; do not start the server now
param([switch]$Autostart, [switch]$RemoveAutostart, [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Ext = Join-Path $Root 'extension'
$Server = Join-Path $Root 'live\server.js'
$Url = 'http://127.0.0.1:4870'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Tab Thrashing server.lnk'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Ask([string]$Question, [bool]$Default) {
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "$Question $hint"
  if ($a -eq '') { return $Default }
  return $a -match '^[yY]'
}

if ($RemoveAutostart) {
  if (Test-Path $Shortcut) { Remove-Item $Shortcut; Say 'Autostart removed.' Green } else { Say 'Autostart was not set up.' }
  exit 0
}

Say ''
Say 'Tab Thrashing setup' Cyan
Say '-------------------' Cyan

# 1. Node.js 18+
function Get-NodeMajor {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return 0 }
  return [int]((& node --version).TrimStart('v').Split('.')[0])
}
$major = Get-NodeMajor
if ($major -lt 18) {
  if ($major -gt 0) { Say "Node.js $major is too old; version 18 or newer is needed." Yellow } else { Say 'Node.js was not found.' Yellow }
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask 'Install Node.js LTS with winget now?' $true)) {
    winget install --id OpenJS.NodeJS.LTS -e
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $major = Get-NodeMajor
  }
  if ($major -lt 18) {
    Say 'Install Node.js 18 or newer from https://nodejs.org, then run setup again.' Red
    exit 1
  }
}
Say "[ok] Node.js $(& node --version)" Green

# 2. Data folder
New-Item -ItemType Directory -Force (Join-Path $Root 'live\data') | Out-Null
Say "[ok] Events will be stored in $(Join-Path $Root 'live\data')" Green

# 3. Browser extension (has to be loaded by hand: browsers do not allow scripts to install unpacked extensions)
try { Set-Clipboard -Value $Ext; $copied = ' (copied to clipboard)' } catch { $copied = '' }
Say ''
Say 'Load the browser extension once:' Cyan
Say '  1. Open chrome://extensions  (Edge: edge://extensions)'
Say '  2. Turn on Developer mode'
Say ('  3. Click "Load unpacked" and choose this folder' + $copied + ':')
Say "     $Ext" White
if (Ask 'Open the extensions page now?' $true) {
  $opened = $false
  foreach ($b in @(@('chrome', 'chrome://extensions'), @('msedge', 'edge://extensions'), @('brave', 'brave://extensions'))) {
    try { Start-Process $b[0] $b[1]; $opened = $true; break } catch {}
  }
  if (-not $opened) { Say '  Could not find Chrome, Edge or Brave. Open the extensions page yourself.' Yellow }
}

# 4. Optional autostart
if ($Autostart -or (-not (Test-Path $Shortcut) -and (Ask 'Start the server automatically when you sign in?' $false))) {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($Shortcut)
  $lnk.TargetPath = (Get-Command node).Source
  $lnk.Arguments = '"' + $Server + '"'
  $lnk.WorkingDirectory = $Root
  $lnk.WindowStyle = 7  # minimized
  $lnk.Description = 'Tab Thrashing live server'
  $lnk.Save()
  Say "[ok] Autostart added. Remove it with: setup.ps1 -RemoveAutostart" Green
}

# 5. Start
if ($NoStart) { Say ''; Say 'Setup done. Start later with start.cmd' Cyan; exit 0 }
$running = $false
try { $running = (Invoke-WebRequest "$Url/api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
Say ''
if ($running) {
  Say "The server is already running. Opening $Url" Cyan
  Start-Process $Url
} else {
  Say "Starting the server on $Url  (Ctrl+C to stop)" Cyan
  Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 1; Start-Process $u } -ArgumentList $Url | Out-Null
  & node $Server
}
