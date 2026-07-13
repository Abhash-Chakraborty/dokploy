<#
.SYNOPSIS
  Deploy the current commit's SHA-tagged Dokploy image to the ARM Swarm server.

.DESCRIPTION
  Updates ONLY the `dokploy` Swarm service. Captures the current image first so
  rollback is possible, pulls the new SHA image, forces a service update, then
  verifies the rollout and that the public URL returns HTTP 200.

  Does NOT touch dokploy-postgres / dokploy-redis / dokploy-traefik /
  dokploy-network-holder.

.EXAMPLE
  ./scripts/deploy-dokploy-arm.ps1
  ./scripts/deploy-dokploy-arm.ps1 -Tag latest     # deploy :latest instead of the SHA
#>
[CmdletBinding()]
param(
  [string]$Tag
)

$ErrorActionPreference = "Stop"

$RepoRoot  = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ImageName = "ghcr.io/abhash-chakraborty/dokploy"
$Server    = "ubuntu@129.154.249.111"
$ServiceName = "dokploy"
$Url       = "https://dokploy.abhashchakraborty.tech/"

Set-Location $RepoRoot

# Match CI's tag exactly: it uses ${GITHUB_SHA::12} (first 12 hex chars).
$ShortSha = (git rev-parse HEAD).Trim().Substring(0, 12)
$DeployImage = if ($Tag) { "${ImageName}:$Tag" } else { "${ImageName}:sha-$ShortSha" }

Write-Host "Deploying image: $DeployImage"
Write-Host "Server         : $Server"
Write-Host "Service        : $ServiceName"

# Capture current image for rollback BEFORE changing anything.
Write-Host "`n== Current running image (save this for rollback) =="
$CurrentImage = ssh $Server "docker service inspect $ServiceName --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'"
Write-Host "  $CurrentImage"

Write-Host "`n== Pulling new image on server =="
ssh $Server "docker pull $DeployImage"
if ($LASTEXITCODE -ne 0) { throw "Server failed to pull $DeployImage (is arm64 in the manifest?)" }

Write-Host "`n== Updating service (dokploy only) =="
ssh $Server "docker service update --with-registry-auth --force --image $DeployImage $ServiceName"
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Service update failed. Roll back with:"
  Write-Warning "  ssh $Server `"docker service update --with-registry-auth --force --image $CurrentImage $ServiceName`""
  throw "Deployment failed."
}

Write-Host "`n== Rollout status =="
ssh $Server "docker service ps $ServiceName --no-trunc"

Write-Host "`n== Recent logs =="
ssh $Server "docker service logs $ServiceName --since 5m --tail 200"

Write-Host "`n== HTTP check =="
ssh $Server "curl -k -sS -L -o /tmp/dokploy-check.html -w 'HTTP=%{http_code} final=%{url_effective}\n' $Url && grep -oi '<title>[^<]*' /tmp/dokploy-check.html | head -1; rm -f /tmp/dokploy-check.html"

Write-Host "`nDeployment finished."
Write-Host "Previous image (for rollback): $CurrentImage"
