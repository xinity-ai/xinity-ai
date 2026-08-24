# Xinity CLI installer for Windows
#
# Usage:
#   irm https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.ps1 | iex
#
# Or with options:
#   & { param($Version, $Prefix) ... } -Version v1.0.0 -Prefix "$env:USERPROFILE\bin"

param(
    [string]$Version = "latest",
    [string]$Prefix = "",
    [string]$Repo = "xinity-ai/xinity-ai"
)

$ErrorActionPreference = "Stop"

if (-not $Prefix) {
    $Prefix = Join-Path ($env:LOCALAPPDATA ?? (Join-Path $env:USERPROFILE "AppData\Local")) "xinity"
}

function Write-Status($Symbol, $Color, $Message) {
    Write-Host "  $Symbol  " -ForegroundColor $Color -NoNewline
    Write-Host $Message
}
function Write-Info($Message) { Write-Status "info" Cyan $Message }
function Write-Pass($Message) { Write-Status "  ok" Green $Message }
function Write-Fail($Message) {
    Write-Status "fail" Red $Message
    exit 1
}
function Write-Warn($Message) { Write-Status "warn" Yellow $Message }

# ── Version resolution ──────────────────────────────────────────────────────

$Headers = @{ "Accept" = "application/vnd.github+json" }

if ($Version -eq "latest") {
    Write-Info "Fetching latest release..."
    $ReleaseUrl = "https://api.github.com/repos/$Repo/releases/latest"
} else {
    $ReleaseUrl = "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

try {
    $Release = Invoke-RestMethod -Uri $ReleaseUrl -Headers $Headers
} catch {
    Write-Fail "Could not fetch release $Version from $Repo."
}

$Tag = $Release.tag_name
if (-not $Tag) {
    Write-Fail "Could not parse release tag"
}

$Suffix = "windows-x64"
$AssetName = "xinity-cli-$Suffix.tar.gz"

$HasAsset = $Release.assets | Where-Object { $_.name -eq $AssetName }
if (-not $HasAsset) {
    $HasLinuxAsset = $Release.assets | Where-Object { $_.name -eq "xinity-cli-linux-x64.tar.gz" }
    if ($HasLinuxAsset) {
        Write-Fail "Release $Tag has Linux builds only. Windows builds are present in newer releases only. Omit -Version to install the latest."
    }
    Write-Fail "$AssetName not found in release $Tag"
}

Write-Info "Installing xinity CLI $Tag ($Suffix)"

# ── Download ────────────────────────────────────────────────────────────────

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "xinity-cli-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

$TarPath = Join-Path $TmpDir $AssetName
$DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$AssetName"

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TarPath
} catch {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    Write-Fail "Download failed: $_"
}

# ── Checksum verification ───────────────────────────────────────────────────

$ShaFile = Join-Path $TmpDir "SHASUMS256.txt"
$ShaUrl = "https://github.com/$Repo/releases/download/$Tag/SHASUMS256.txt"

try {
    Invoke-WebRequest -Uri $ShaUrl -OutFile $ShaFile
    $Expected = (Get-Content $ShaFile | Where-Object { $_ -match $AssetName } | ForEach-Object { ($_ -split '\s+')[0] })
    if ($Expected) {
        $Actual = (Get-FileHash -Path $TarPath -Algorithm SHA256).Hash.ToLower()
        if ($Expected -eq $Actual) {
            Write-Pass "SHA256 verified"
        } else {
            Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
            Write-Fail "SHA256 mismatch: expected $Expected, got $Actual"
        }
    } else {
        Write-Warn "Asset not found in SHASUMS256.txt, skipping verification"
    }
} catch {
    Write-Warn "Could not fetch checksums, skipping verification"
}

# ── Extract and install ─────────────────────────────────────────────────────

$ExtractDir = Join-Path $TmpDir "extracted"
New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
tar -xzf $TarPath -C $ExtractDir

New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
$DestPath = Join-Path $Prefix "xinity.exe"
Move-Item -Path (Join-Path $ExtractDir "xinity.exe") -Destination $DestPath -Force

Write-Pass "Installed xinity $Tag to $DestPath"

# ── PATH check ──────────────────────────────────────────────────────────────

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$Prefix*") {
    [Environment]::SetEnvironmentVariable("Path", "$Prefix;$UserPath", "User")
    Write-Pass "Added $Prefix to user PATH"
    Write-Warn "Restart your terminal for PATH changes to take effect"
}

# ── Cleanup ─────────────────────────────────────────────────────────────────

Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue

Write-Host ""
Write-Info "Run 'xinity --help' to get started"
