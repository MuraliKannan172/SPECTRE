<#
.SYNOPSIS
  Download optional datasets that SKYNET does not ship because their licenses
  forbid commercial use or redistribution.

.DESCRIPTION
  TeleGeography Submarine Cable Map (CC BY-NC-SA 3.0): cable routes and
  landing points for the Submarine Cables layer. Personal, non-commercial use
  only. The files land in a gitignored folder and are never committed.

  Run from the repository root in PowerShell:
    .\scripts\fetch-optional-data.ps1 -AcceptNonCommercialLicense

.PARAMETER AcceptNonCommercialLicense
  Required. Confirms you read the license and will use the data only for
  personal, non-commercial purposes.
#>
[CmdletBinding()]
param(
  [switch]$AcceptNonCommercialLicense
)

$ErrorActionPreference = 'Stop'

$licenseNotice = @'
TeleGeography Submarine Cable Map data is licensed CC BY-NC-SA 3.0
(https://creativecommons.org/licenses/by-nc-sa/3.0/). You may use it only for
personal, non-commercial purposes, with attribution to TeleGeography, and must
not redistribute it with SKYNET. Commercial use needs a TeleGeography license.
'@

if (-not $AcceptNonCommercialLicense) {
  Write-Host $licenseNotice
  Write-Host 'Re-run with -AcceptNonCommercialLicense to download.'
  exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repoRoot 'src\data\local_data\telegeography_submarine_cables'
New-Item -ItemType Directory -Force -Path $target | Out-Null

$files = @(
  @{ Name = 'cable-geo.json'; Url = 'https://www.submarinecablemap.com/api/v3/cable/cable-geo.json' },
  @{ Name = 'landing-point-geo.json'; Url = 'https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json' }
)

foreach ($file in $files) {
  $destination = Join-Path $target $file.Name
  Write-Host "Downloading $($file.Url)"
  Invoke-WebRequest -Uri $file.Url -OutFile $destination -UseBasicParsing -TimeoutSec 60
  $parsed = Get-Content -Raw -Path $destination | ConvertFrom-Json
  if (-not $parsed.features) {
    Remove-Item -Force $destination
    throw "$($file.Name) did not contain a GeoJSON FeatureCollection"
  }
  Write-Host "  $($file.Name): $($parsed.features.Count) features"
}

Set-Content -Encoding utf8 -Path (Join-Path $target 'LICENSE.txt') -Value $licenseNotice
Write-Host "Done. Restart 'npm run dev' and enable Submarine Cables in Data Layers."
