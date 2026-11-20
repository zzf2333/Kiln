<#
.SYNOPSIS
Kiln CLI Installer for Windows x64 (Zero-Dependency Standalone Binary).

.DESCRIPTION
Downloads prebuilt `kiln-v<version>-windows-x64.exe` from GitHub Releases (`zzf2333/Kiln`),
verifies its SHA-256 digest against `SHA256SUMS`, and installs `kiln.exe` + `kl.cmd` into
`%LOCALAPPDATA%\Kiln\bin` (or `<Prefix>\bin`) without UAC, Registry/PATH mutation,
PowerShell profile edits, or automatic startup registration.
#>
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Prefix = "",
  [switch]$DryRun,
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoSlug = "zzf2333/Kiln"
$ReleaseBaseUrl = if ($env:KILN_RELEASE_BASE_URL) { $env:KILN_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$RepoSlug/releases/download" }
$ReleaseLatestApiUrl = if ($env:KILN_RELEASE_LATEST_API_URL) { $env:KILN_RELEASE_LATEST_API_URL } else { "https://api.github.com/repos/$RepoSlug/releases/latest" }

function Show-Usage {
  @(
    "Kiln CLI Installer for Windows x64 (Zero-Dependency Standalone Binary)"
    ""
    "Usage:"
    "  install.ps1 [-Version <ver>] [-Prefix <dir>] [-DryRun] [-Help]"
    ""
    "Options:"
    "  -Version <ver>   Install a specific Kiln version (e.g. 0.1.0 or v0.1.0)"
    "  -Prefix <dir>    Install into <dir>\bin (default: %LOCALAPPDATA%\Kiln -> %LOCALAPPDATA%\Kiln\bin)"
    "  -DryRun          Print planned download URL, checksum plan, and install paths without modifying disk"
    "  -Help            Show this help message"
    ""
    "Guarantees:"
    "  - Zero Node.js / npm runtime requirement (downloads prebuilt single binary + verifies SHA256SUMS)"
    "  - Zero UAC / administrator privileges required"
    "  - Never modifies PowerShell profiles, HKCU Run startup entries, or system PATH silently"
  ) -join [Environment]::NewLine | Write-Output
}

function Assert-WindowsX64 {
  $arch = ""
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    $arch = $env:PROCESSOR_ARCHITECTURE
  }
  if ($arch -notin @("X64", "AMD64", "x64", "amd64")) {
    throw "Unsupported Windows architecture '$arch': only x64 (windows-x64) is currently supported."
  }
}

function Resolve-LatestVersion {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ "User-Agent" = "kiln-installer" }
  $release = Invoke-RestMethod -Uri $ReleaseLatestApiUrl -Headers $headers -Method Get
  if (-not $release -or -not $release.tag_name) {
    throw "Unable to resolve latest Kiln release from $ReleaseLatestApiUrl. Pass -Version explicitly."
  }
  return ([string]$release.tag_name).TrimStart("v")
}

function Find-ExpectedSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$SumsPath,
    [Parameter(Mandatory = $true)][string]$AssetName
  )
  foreach ($line in Get-Content -Path $SumsPath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    $parts = $trimmed -split "\s+", 2
    if ($parts.Count -lt 2) { continue }
    $hash = $parts[0].ToLowerInvariant()
    $name = $parts[1].Trim()
    if ($name.StartsWith("*")) { $name = $name.Substring(1) }
    if ($name.StartsWith("./")) { $name = $name.Substring(2) }
    if ($name -eq $AssetName) {
      if ($hash -notmatch "^[0-9a-f]{64}$") {
        throw "Invalid SHA-256 format for $AssetName in SHA256SUMS: $hash"
      }
      return $hash
    }
  }
  throw "No SHA-256 entry found for $AssetName in SHA256SUMS."
}

function Write-NextSteps {
  param([Parameter(Mandatory = $true)][string]$BinDir)
  $pathEntries = @()
  if ($env:PATH) {
    $pathEntries = $env:PATH -split ";" | ForEach-Object { $_.Trim().TrimEnd("\").ToLowerInvariant() }
  }
  $normalizedBin = $BinDir.TrimEnd("\").ToLowerInvariant()

  Write-Output ""
  Write-Output "Next steps:"
  if ($pathEntries -notcontains $normalizedBin) {
    Write-Output "  Add `"$BinDir`" to your user PATH (this installer never edits PATH or PowerShell profiles):"
    Write-Output "    `$env:PATH = `"$BinDir;`$env:PATH`"   # current session"
  }
  Write-Output "  1. Verify environment:     kiln doctor"
  Write-Output "  2. Start local daemon:     kiln up"
  Write-Output "  3. Optional auto-start:    kiln service install"
  Write-Output "  4. Clean uninstall:        kiln uninstall"
  Write-Output "  (Short alias 'kl.cmd' is installed alongside 'kiln.exe'.)"
}

if ($Help) {
  Show-Usage
  exit 0
}

Assert-WindowsX64

$cleanVersion = $Version.Trim()
if ($cleanVersion.StartsWith("v")) {
  $cleanVersion = $cleanVersion.Substring(1)
}
if ($cleanVersion -and ($cleanVersion -notmatch "^[0-9A-Za-z._+-]+$")) {
  throw "Invalid -Version characters: $Version"
}

$effectivePrefix = $Prefix.Trim()
if (-not $effectivePrefix) {
  if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is not set; specify -Prefix explicitly."
  }
  $effectivePrefix = Join-Path $env:LOCALAPPDATA "Kiln"
}
$binDir = Join-Path $effectivePrefix "bin"

if ($DryRun) {
  $displayVersion = if ($cleanVersion) { $cleanVersion } else { "latest" }
  $tagLabel = if ($cleanVersion) { "v$cleanVersion" } else { "v<latest>" }
  $assetName = "kiln-$tagLabel-windows-x64.exe"
  $binaryUrl = "$ReleaseBaseUrl/$tagLabel/$assetName"
  $sumsUrl = "$ReleaseBaseUrl/$tagLabel/SHA256SUMS"

  Write-Output "[dry-run] Planned Kiln standalone binary installation (no files will be modified):"
  Write-Output "  Target:      windows-x64"
  Write-Output "  Version:     $displayVersion"
  Write-Output "  Runtime:     Standalone binary (Node.js not required, zero UAC)"
  Write-Output "  Binary URL:  $binaryUrl"
  Write-Output "  Checksums:   $sumsUrl"
  Write-Output "  Install bin: $(Join-Path $binDir 'kiln.exe')"
  Write-Output "  Alias shim:  $(Join-Path $binDir 'kl.cmd')"
  Write-Output "  Registry / startup / PowerShell profiles: untouched"
  Write-NextSteps -BinDir $binDir
  exit 0
}

if (-not $cleanVersion) {
  $cleanVersion = Resolve-LatestVersion
}

$tag = "v$cleanVersion"
$assetName = "kiln-$tag-windows-x64.exe"
$binaryUrl = "$ReleaseBaseUrl/$tag/$assetName"
$sumsUrl = "$ReleaseBaseUrl/$tag/SHA256SUMS"

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("kiln-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $binDownload = Join-Path $tmpDir $assetName
  $sumsDownload = Join-Path $tmpDir "SHA256SUMS"

  Write-Output "Downloading Kiln $tag (windows-x64)..."
  Invoke-WebRequest -Uri $binaryUrl -OutFile $binDownload -UseBasicParsing
  Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsDownload -UseBasicParsing

  $expectedSha = Find-ExpectedSha256 -SumsPath $sumsDownload -AssetName $assetName
  $actualSha = (Get-FileHash -Path $binDownload -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha) {
    throw "SHA-256 mismatch for ${assetName}: expected $expectedSha, got $actualSha."
  }

  New-Item -ItemType Directory -Path $binDir -Force | Out-Null

  $destExe = Join-Path $binDir "kiln.exe"
  $stagedExe = Join-Path $binDir (".kiln.tmp." + $PID + ".exe")
  Copy-Item -Path $binDownload -Destination $stagedExe -Force
  Move-Item -Path $stagedExe -Destination $destExe -Force

  $destKl = Join-Path $binDir "kl.cmd"
  $stagedKl = Join-Path $binDir (".kl.tmp." + $PID + ".cmd")
  $klShim = "@echo off`r`n`"%~dp0kiln.exe`" %*`r`n"
  [System.IO.File]::WriteAllText($stagedKl, $klShim, [System.Text.Encoding]::ASCII)
  Move-Item -Path $stagedKl -Destination $destKl -Force

  Write-Output "Installed kiln $tag (windows-x64) to $destExe (verified SHA-256: $actualSha)."
  Write-NextSteps -BinDir $binDir
} finally {
  if (Test-Path -LiteralPath $tmpDir) {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
