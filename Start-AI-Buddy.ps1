$ErrorActionPreference = 'Stop'
$aiChanRoot = $PSScriptRoot
$aiChanPointer = Get-Content -LiteralPath (Join-Path $aiChanRoot 'local/current-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$aiChanBuildPath = if ([IO.Path]::IsPathRooted($aiChanPointer.path)) { $aiChanPointer.path } else { Join-Path $aiChanRoot $aiChanPointer.path }
$aiChanBuild = [IO.Path]::GetFullPath($aiChanBuildPath)
if (-not $aiChanBuild.StartsWith($aiChanRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid build path' }
if (-not (Test-Path -LiteralPath (Join-Path $aiChanBuild 'main.cjs'))) { throw 'AI Buddy build is missing' }
$aiChanRuntime = if ($aiChanPointer.runtime) { Join-Path $aiChanRoot $aiChanPointer.runtime.path } else { Join-Path $aiChanRoot 'runtime/electron-44.6.0' }
$aiChanExeName = if ($aiChanPointer.runtime) { $aiChanPointer.runtime.executable } else { 'electron.exe' }
if ([IO.Path]::GetFileName($aiChanExeName) -ne $aiChanExeName) { throw 'Invalid executable name' }
$aiChanExe = [IO.Path]::GetFullPath((Join-Path $aiChanRuntime $aiChanExeName))
if (-not $aiChanExe.StartsWith((Join-Path $aiChanRoot 'runtime\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime path' }
if ($aiChanPointer.runtime.sha256 -and (Get-FileHash -LiteralPath $aiChanExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $aiChanPointer.runtime.sha256) { throw 'Executable hash mismatch' }
Start-Process -FilePath $aiChanExe -ArgumentList @('"' + $aiChanBuild + '"', '--open=overview') -WorkingDirectory $aiChanRoot -WindowStyle Hidden
