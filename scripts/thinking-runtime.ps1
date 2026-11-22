param([string]$Script = 'thinking-runtime.mjs')
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null
$start = [System.Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
$start.Arguments = '"' + (Join-Path $PSScriptRoot $Script) + '"'
$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEndAsync()
if (-not $process.WaitForExit(45000)) { $process.Kill($true); throw 'DSH runtime check timed out' }
[Console]::Out.Write($stdout.Result)
[Console]::Error.Write($stderr.Result)
exit $process.ExitCode
