$ErrorActionPreference = "Stop"

# Derive the repository root from this script's location (scripts/ -> repo root).
$Repo = Split-Path -Parent $PSScriptRoot

Write-Host "== Relay M0 bootstrap =="
Write-Host "Workspace: $Repo"

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
  throw "Pi is not available on PATH."
}

Write-Host "`n== Pi version =="
pi --version

Write-Host "`n== GLM-5.3 candidates =="
pi --list-models "glm-5.3"

Write-Host @"

IMPORTANT:
Select the exact GLM-5.3 provider/model ID shown above.
Do not fall back silently.

Then launch Pi from:
  $Repo

with:
  pi --name "relay-m0" --model "<EXACT_GLM_5_3_MODEL_ID>" -p "@prompts/AGENTDOCK_PI_GLM53.md"

If your provider requires an explicit provider flag:
  pi --name "relay-m0" --provider "<PROVIDER>" --model "<MODEL_ID>" -p "@prompts/AGENTDOCK_PI_GLM53.md"

AgentDock should supervise this Pi process/session and keep the repository working directory at:
  $Repo
"@
