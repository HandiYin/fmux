# Prints the process table again and again, for the fmux hub on Windows.
# One line for each process: pid, parent pid, start time (Unix ms), name, command line, with tabs
# between them. A line "<<end>>" closes each table. Stops when the hub is gone.
param([int]$ParentPid = 0, [int]$IntervalMs = 2000)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$out = [Console]::Out
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)

while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  try {
    $rows = Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate
    foreach ($p in $rows) {
      $started = 0
      if ($p.CreationDate) { $started = [long]($p.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds }
      $line = "$($p.CommandLine)" -replace '[\r\n\t]+', ' '
      $out.WriteLine("$($p.ProcessId)`t$($p.ParentProcessId)`t$started`t$($p.Name)`t$line")
    }
  } catch {
    $out.WriteLine("<<error>>`t$($_.Exception.Message -replace '[\r\n\t]+', ' ')")
  }
  $out.WriteLine('<<end>>')
  $out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
