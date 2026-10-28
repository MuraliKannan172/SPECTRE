<# Deprecated: SKYNET is now SPECTRE. This forwards to scripts\spectre.ps1 with the same parameters; it goes away in the release after next. #>
param([int]$Port = 8100, [switch]$IntelOnly, [switch]$Sync, [switch]$Voice)
Write-Warning 'scripts\skynet.ps1 is deprecated: use scripts\spectre.ps1 (SKYNET is now SPECTRE).'
& (Join-Path $PSScriptRoot 'spectre.ps1') @PSBoundParameters
exit $LASTEXITCODE
