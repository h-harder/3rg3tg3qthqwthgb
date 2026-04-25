# Keeps Windows awake while this PowerShell process is running.
$ErrorActionPreference = 'SilentlyContinue'
$DataDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$PidPath = Join-Path $DataDir 'keepawake.pid'
$PID | Out-File -Encoding ascii -FilePath $PidPath -Force

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Awake {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

$ES_CONTINUOUS = [uint32]0x80000000
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
$ES_DISPLAY_REQUIRED = [uint32]0x00000002
$ES_AWAYMODE_REQUIRED = [uint32]0x00000040

while ($true) {
  [Awake]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED -bor $ES_AWAYMODE_REQUIRED) | Out-Null
  Start-Sleep -Seconds 45
}
