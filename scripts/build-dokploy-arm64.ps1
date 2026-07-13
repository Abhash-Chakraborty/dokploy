<#
.SYNOPSIS
  One-click multi-arch (amd64 + arm64) build & push of the Dokploy image to GHCR.

.DESCRIPTION
  Builds from the repo root (monorepo Dockerfile lives there), pushes :latest and
  :sha-<short-git-sha>, then verifies the pushed manifest actually contains
  linux/arm64. Fails loudly if arm64 is missing.

  Requires: Docker Desktop running, buildx, and a prior `docker login ghcr.io`
  (or a GHCR PAT in the GHCR_TOKEN env var — never commit the token).

.EXAMPLE
  ./scripts/build-dokploy-arm64.ps1
  ./scripts/build-dokploy-arm64.ps1 -ArmOnly      # fallback if multi-arch fails
#>
[CmdletBinding()]
param(
  [switch]$ArmOnly
)

$ErrorActionPreference = "Stop"

# Repo root = parent of this script's directory (portable, not hardcoded).
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ImageName = "ghcr.io/abhash-chakraborty/dokploy"

Set-Location $RepoRoot

$Branch = (git branch --show-current).Trim()
# Match CI's tag exactly: it uses ${GITHUB_SHA::12} (first 12 hex chars).
$ShortSha = (git rev-parse HEAD).Trim().Substring(0, 12)

Write-Host "Repo root : $RepoRoot"
Write-Host "Branch    : $Branch"
Write-Host "Commit    : $ShortSha"

$LatestImage = "${ImageName}:latest"
$ShaImage    = "${ImageName}:sha-$ShortSha"

# --- Preflight ---------------------------------------------------------------
Write-Host "`n== Checking Docker =="
docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker is not running. Start Docker Desktop and retry." }

docker buildx version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker Buildx is not available." }

# Optional non-interactive login if a token is provided via env var.
if ($env:GHCR_TOKEN) {
  Write-Host "Logging in to GHCR using GHCR_TOKEN env var..."
  $env:GHCR_TOKEN | docker login ghcr.io -u abhash-chakraborty --password-stdin
  if ($LASTEXITCODE -ne 0) { throw "GHCR login failed." }
}

# --- Builder -----------------------------------------------------------------
Write-Host "`n== Preparing buildx builder =="
docker buildx create --name dokploy-builder --use 2>$null
if ($LASTEXITCODE -ne 0) { docker buildx use dokploy-builder }
docker buildx inspect --bootstrap | Out-Null

# The CI workflow copies the prod env example before building; mirror that so a
# local build matches CI behavior.
if (Test-Path "apps/dokploy/.env.production.example") {
  Copy-Item "apps/dokploy/.env.production.example" ".env.production" -Force
  Copy-Item "apps/dokploy/.env.production.example" "apps/dokploy/.env.production" -Force
}

$Platforms = if ($ArmOnly) { "linux/arm64" } else { "linux/amd64,linux/arm64" }
Write-Host "`n== Building $Platforms =="
Write-Host "Tags: $LatestImage , $ShaImage"

docker buildx build `
  --platform $Platforms `
  -t $LatestImage `
  -t $ShaImage `
  --push `
  .
if ($LASTEXITCODE -ne 0) {
  if (-not $ArmOnly) {
    throw "Multi-arch build failed. Retry ARM-only with: ./scripts/build-dokploy-arm64.ps1 -ArmOnly"
  }
  throw "Build failed."
}

# --- Verify manifest ---------------------------------------------------------
Write-Host "`n== Verifying pushed manifest contains linux/arm64 =="
$Manifest = docker buildx imagetools inspect $LatestImage | Out-String
Write-Host $Manifest

if ($Manifest -notmatch "linux/arm64") {
  throw "linux/arm64 is MISSING from the pushed manifest for $LatestImage"
}

Write-Host "`nBuild completed successfully."
Write-Host "Deploy this immutable tag to the ARM server:"
Write-Host "  $ShaImage"
Write-Host "(:latest also updated: $LatestImage)"
