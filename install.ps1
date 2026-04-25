# HomeChat Handoff installer for Windows 11 PowerShell
$ErrorActionPreference = 'Stop'

$InstallDir = if ($env:HOMECHAT_HOME) { $env:HOMECHAT_HOME } else { Join-Path $env:USERPROFILE '.homechat' }
$Repo = if ($env:HOMECHAT_REPO) { $env:HOMECHAT_REPO } elseif ($env:SIMPLE_CHAT_REPO) { $env:SIMPLE_CHAT_REPO } else { '' }
$Ref = if ($env:HOMECHAT_REF) { $env:HOMECHAT_REF } else { 'main' }
$TmpDir = $null

function Info($Message) { Write-Host "`n[HomeChat] $Message" }
function Fail($Message) { throw "[HomeChat ERROR] $Message" }
function Command-Exists($Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Node-Major() {
  try { return [int]((node -v).TrimStart('v').Split('.')[0]) } catch { return 0 }
}
function Refresh-Path() {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
  $nodeDir = 'C:\Program Files\nodejs'
  if (Test-Path $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
}
function Ensure-Node() {
  Refresh-Path
  if ((Command-Exists node) -and (Command-Exists npm) -and ((Node-Major) -ge 18)) { return }
  Info 'Node.js 18+ was not found. Trying to install Node.js LTS using winget.'
  if (-not (Command-Exists winget)) {
    Fail 'winget was not found. Install Node.js LTS from https://nodejs.org, open a new PowerShell window, and rerun this installer.'
  }
  winget install OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Command-Exists node) -or -not (Command-Exists npm) -or ((Node-Major) -lt 18)) {
    Fail 'Node.js installed, but node/npm are not available in this PowerShell session. Open a new PowerShell window and rerun this installer.'
  }
}
function Find-SourceDir() {
  if ($Repo) {
    $script:TmpDir = Join-Path ([IO.Path]::GetTempPath()) ('homechat-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:TmpDir | Out-Null
    $zip = Join-Path $script:TmpDir 'source.zip'
    $url = "https://github.com/$Repo/archive/refs/heads/$Ref.zip"
    Info "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $script:TmpDir -Force
    $pkg = Get-ChildItem -Path $script:TmpDir -Recurse -Filter package.json | Select-Object -First 1
    if (-not $pkg) { Fail 'Could not find package.json inside downloaded repo zip.' }
    return $pkg.Directory.FullName
  }
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'package.json'))) {
    return $PSScriptRoot
  }
  Fail 'No source directory found. For one-command install, set $env:HOMECHAT_REPO before running install.ps1.'
}
function Random-Hex() {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}
function Write-EnvIfMissing() {
  $envFile = Join-Path $InstallDir '.env'
  if (Test-Path $envFile) { return }
  @"
PORT=3000
APP_NAME=HomeChat
SESSION_SECRET=$(Random-Hex)
ADMIN_KEY=$(Random-Hex)
PEER_URL=
HANDOFF_ON_START=true
"@ | Set-Content -Path $envFile -Encoding UTF8
}
function Install-Command() {
  $binDir = Join-Path $env:USERPROFILE '.local\bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $cmdPath = Join-Path $binDir 'homechat.cmd'
  $psPath = Join-Path $binDir 'homechat.ps1'
  "@echo off`r`nnode `"$InstallDir\cli.js`" %*`r`n" | Set-Content -Path $cmdPath -Encoding ASCII
  "node `"$InstallDir\cli.js`" @args`r`n" | Set-Content -Path $psPath -Encoding UTF8
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $binDir })) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
    $env:Path = "$env:Path;$binDir"
  }
}

try {
  Ensure-Node
  $src = Find-SourceDir
  Info "Installing app to $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Get-ChildItem -Path $src -Force | Where-Object { $_.Name -notin @('data','logs','backups') } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $InstallDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'data'), (Join-Path $InstallDir 'logs'), (Join-Path $InstallDir 'backups') | Out-Null
  Push-Location $InstallDir
  npm install --omit=dev
  Pop-Location
  Write-EnvIfMissing
  Install-Command
  Info "Installed. Open a new PowerShell window and run: homechat"
  Info "Or run now with: $env:USERPROFILE\.local\bin\homechat.cmd"
}
finally {
  if ($TmpDir -and (Test-Path $TmpDir)) { Remove-Item -Recurse -Force $TmpDir }
}
