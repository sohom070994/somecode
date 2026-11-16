# Called by test.bat after each run: appends one entry to test-logs\YYYY-MM-DD.log with when it
# started and finished, python's exit code, and anything test_final.py printed (errors included).
param([string]$Started, [string]$Code, [string]$OutFile, [string]$LogDir)

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$now = Get-Date
$status = if ($Code -eq '0') { 'OK' } else { "FAILED (exit code $Code)" }
$lines = @(
  "$($now.ToString('yyyy-MM-dd HH:mm:ss'))  test.bat run - $status",
  "    started:  $($Started.Trim())",
  "    finished: $($now.ToString('yyyy-MM-dd HH:mm:ss.ff'))"
)
$output = if (Test-Path $OutFile) { (Get-Content $OutFile -Raw) } else { $null }
if ($output -and $output.Trim()) {
  $lines += '    output:'
  $lines += ($output.TrimEnd() -split "`r?`n" | ForEach-Object { "      $_" })
}
Add-Content -Path (Join-Path $LogDir "$($now.ToString('yyyy-MM-dd')).log") -Value $lines -Encoding utf8
