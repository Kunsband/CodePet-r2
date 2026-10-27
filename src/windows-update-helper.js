// Runs outside Electron so the portable launcher can exit and release its EXE.
// All paths arrive as JSON in the environment, never as PowerShell source.
const WINDOWS_UPDATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$config = $env:CODEPET_UPDATE_CONFIG | ConvertFrom-Json
Remove-Item Env:CODEPET_UPDATE_CONFIG
$target = [IO.Path]::GetFullPath($config.target)
$stage = [IO.Path]::GetFullPath($config.stage)
if ([IO.Path]::GetDirectoryName($stage) -ne [IO.Path]::GetDirectoryName($target) -or
    [IO.Path]::GetFileName($stage) -notmatch '^\.codepet-update-[a-zA-Z0-9]+$' -or
    ((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
$payload = Join-Path $stage 'update.exe'
$backup = Join-Path $stage 'previous.exe'
$health = Join-Path $stage 'started'
$replaced = $false
$parentExited = $false
$launched = $null
function Get-Sha256($file) {
  $stream = [IO.File]::OpenRead($file)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hash.Dispose() }
}
function Wait-Until($condition, $seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Update timed out.'
}
function Start-CodePet {
  # The previous portable launcher points at a temporary extraction directory.
  Remove-Item Env:PORTABLE_EXECUTABLE_FILE, Env:PORTABLE_EXECUTABLE_DIR, Env:PORTABLE_EXECUTABLE_APP_FILENAME, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $target
  $start.WorkingDirectory = [IO.Path]::GetDirectoryName($target)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  return [Diagnostics.Process]::Start($start)
}
try {
  if ((Get-Sha256 $payload) -ne $config.sha256) { throw 'Checksum mismatch.' }
  if ((Get-Sha256 $target) -ne $config.previousSha256) { throw 'The installed file changed.' }
  $parent = Get-Process -Id $config.parentPid -ErrorAction Stop
  [IO.File]::WriteAllText((Join-Path $stage 'ready'), 'ready')
  Wait-Until { Test-Path -LiteralPath (Join-Path $stage 'apply') } 30
  if (-not $parent.WaitForExit(60000)) { throw 'CodePet did not exit.' }
  $parentExited = $true
  # NSIS remains alive briefly after Electron exits. Retry only while the old
  # file is locked; File.Replace keeps the original intact on failure.
  Wait-Until {
    try {
      if ((Get-Sha256 $target) -ne $config.previousSha256) { return $false }
      [IO.File]::Replace($payload, $target, $backup)
      return $true
    } catch { return $false }
  } 60
  $replaced = $true
  $env:CODEPET_UPDATE_STAGE = $stage
  $launched = Start-CodePet
  Wait-Until {
    if (Test-Path -LiteralPath $health) { return $true }
    if ($launched.HasExited) { throw 'The updated app exited before startup completed.' }
    return $false
  } 120
  Remove-Item Env:CODEPET_UPDATE_STAGE
  try { Remove-Item -LiteralPath $stage -Recurse -Force } catch {}
} catch {
  $failure = $_.Exception.Message + ' ' + $_.ScriptStackTrace
  if ($replaced) {
    try {
      # Only terminate the process tree this helper launched, never an existing app.
      if ($null -ne $launched -and -not $launched.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $launched.Id /T /F | Out-Null
        if (-not $launched.WaitForExit(15000)) { throw 'Updated app could not be stopped.' }
      }
      [IO.File]::Replace($backup, $target, $payload)
      $replaced = $false
    } catch { $failure += ' Rollback failed: ' + $_.Exception.Message }
  }
  [IO.File]::WriteAllText((Join-Path $stage 'update.log'), $failure)
  if ($parentExited -and -not $replaced) {
    Remove-Item Env:CODEPET_UPDATE_STAGE -ErrorAction SilentlyContinue
    $env:CODEPET_UPDATE_FAILED = '1'
    try { $null = Start-CodePet } catch {}
  }
  exit 1
}
`;

module.exports = { WINDOWS_UPDATE_SCRIPT };
