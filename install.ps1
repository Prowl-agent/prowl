#Requires -Version 5.1
<#
.SYNOPSIS
  Prowl installer for Windows.
  Usage: irm https://prowl.dev/install.ps1 | iex
#>
$ErrorActionPreference = 'Stop'
$ProwlVersion = '0.1.0'
$ProwlRepo    = 'https://github.com/prowl-agent/prowl'
$ProwlDir     = Join-Path $env:USERPROFILE '.prowl\app'
$ProwlConfig  = Join-Path $env:USERPROFILE '.prowl\config.json'
$ProwlLog     = Join-Path $env:USERPROFILE '.prowl\install.log'

New-Item -ItemType Directory -Path (Split-Path $ProwlLog) -Force | Out-Null
Start-Transcript -Path $ProwlLog -Append | Out-Null

function Write-Step  { param($n,$msg) Write-Host "  [$n/5] $msg" -NoNewline -ForegroundColor White }
function Write-Ok    { param($msg) Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "  ❌ $msg" -ForegroundColor Red }
function Write-Info  { param($msg) Write-Host "  →  $msg" -ForegroundColor Cyan }
function Abort       { param($msg) Write-Err $msg; Stop-Transcript; exit 1 }

Write-Host ""
Write-Host "  🐾 Prowl $ProwlVersion" -ForegroundColor White
Write-Host "     Your AI agent. Your hardware. Zero cost."
Write-Host ""

# ── Idempotency ──────────────────────────────────────────────────────
if ((Test-Path $ProwlConfig) -and (Test-Path (Join-Path $ProwlDir '.git'))) {
  $cur = (Get-Content $ProwlConfig -Raw | ConvertFrom-Json).model
  Write-Host "  Existing install detected (model: $cur)" -ForegroundColor White
  $r = Read-Host "  Update to latest? (Y/n)"
  if ($r -match '^[Nn]') { Write-Host '  No changes made.'; exit 0 }
  Write-Host ''
}

# ── [1/5] Node.js ────────────────────────────────────────────────────
Write-Step 1 'Checking Node.js...           '
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nv = & node -e "process.stdout.write(process.version)"
  $major = [int]($nv -replace '^v','').Split('.')[0]
  if ($major -ge 22) { Write-Ok "$nv found" }
  else {
    Write-Host ''; Write-Info "Found $nv, need 22+. Installing via winget..."
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    Write-Ok "Node.js $(& node -e "process.stdout.write(process.version)")"
  }
} else {
  Write-Host ''; Write-Info 'Not found. Installing via winget...'
  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Abort 'Node.js 22+ is required. Install from https://nodejs.org'
  }
  Write-Ok "Node.js $(& node -e "process.stdout.write(process.version)")"
}

# ── [2/5] Ollama ─────────────────────────────────────────────────────
Write-Step 2 'Checking Ollama...            '
if (Get-Command ollama -ErrorAction SilentlyContinue) {
  $ov = & ollama --version 2>$null | Select-Object -First 1
  Write-Ok ($ov ?? 'installed')
} else {
  Write-Host '📦 Installing...' -NoNewline
  winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Abort "Ollama install failed. See $ProwlLog" }
  Write-Ok 'installed'
}
# Ensure running
try { $null = Invoke-RestMethod -Uri 'http://localhost:11434/' -TimeoutSec 2 } catch {
  Write-Info 'Starting Ollama...'
  Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try { $null = Invoke-RestMethod -Uri 'http://localhost:11434/' -TimeoutSec 2; break } catch {}
  }
  try { $null = Invoke-RestMethod -Uri 'http://localhost:11434/' -TimeoutSec 2 } catch {
    Abort "Could not start Ollama. Run 'ollama serve' manually."
  }
}

# ── [3/5] Hardware ───────────────────────────────────────────────────
Write-Step 3 'Detecting hardware...         '
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$cpu   = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name -replace '\s+', ' '
$gpu   = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
$gpuLabel = if ($gpu -match 'NVIDIA|GeForce|RTX|GTX') { " + $($gpu.Trim())" } else { '' }
Write-Host "🖥️  $cpu, ${ramGB}GB RAM$gpuLabel"

# ── [4/5] Pull model ────────────────────────────────────────────────
$avail = $ramGB - 6
if     ($avail -ge 40) { $model = 'qwen3:32b';         $ml = 'Qwen3 32B' }
elseif ($avail -ge 14) { $model = 'qwen2.5-coder:14b'; $ml = 'Qwen2.5-Coder 14B' }
elseif ($avail -ge  8) { $model = 'qwen3:8b';          $ml = 'Qwen3 8B' }
elseif ($avail -ge  4) { $model = 'qwen3:4b';          $ml = 'Qwen3 4B' }
else { Abort "Insufficient memory (${ramGB}GB). At least 10GB RAM required." }

# Check for NVIDIA GPU — prefer larger model if VRAM available
if ($gpu -match 'RTX\s*(30|40|50)' -and $avail -lt 14) {
  $model = 'qwen2.5-coder:14b'; $ml = 'Qwen2.5-Coder 14B (NVIDIA GPU detected)'
}

Write-Host "  [4/5] Pulling AI model...           ⬇️  $ml" -ForegroundColor White
$existing = & ollama list 2>$null | Select-String "^$model"
if ($existing) { Write-Ok "$model already installed" }
else { & ollama pull $model; Write-Ok "$model ready" }

# ── [5/5] Install / update ──────────────────────────────────────────
Write-Step 5 'Setting up Prowl...           '
if (Test-Path (Join-Path $ProwlDir '.git')) {
  & git -C $ProwlDir pull --ff-only origin main 2>&1 | Out-Null
} else {
  New-Item -ItemType Directory -Path (Split-Path $ProwlDir) -Force | Out-Null
  & git clone --depth 1 $ProwlRepo $ProwlDir 2>&1 | Out-Null
}
Push-Location $ProwlDir
if (Get-Command pnpm -ErrorAction SilentlyContinue) { & pnpm install --frozen-lockfile 2>&1 | Out-Null }
else { & npm install 2>&1 | Out-Null }
Pop-Location
Write-Ok 'Ready!'

# ── Config ───────────────────────────────────────────────────────────
if (-not (Test-Path $ProwlConfig)) {
  @{ model=$model; ollamaUrl='http://localhost:11434'; installedAt=(Get-Date -Format o); prowlVersion=$ProwlVersion } |
    ConvertTo-Json | Set-Content $ProwlConfig
}

# ── Done ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  🐾 Prowl is ready!' -ForegroundColor Green
Write-Host ''
Write-Host "     Dashboard:  http://localhost:18789" -ForegroundColor Cyan
Write-Host "     Docs:       https://prowl.dev/docs" -ForegroundColor Cyan
Write-Host "     Log:        $ProwlLog"
Write-Host ''
Write-Host '     💰 Savings vs GPT-4o: $0.00 and counting' -ForegroundColor Yellow
Write-Host ''

$sr = Read-Host '  Start Prowl now? (Y/n)'
if ($sr -notmatch '^[Nn]') {
  Write-Info 'Starting Prowl...'
  Push-Location $ProwlDir
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { Start-Process pnpm -ArgumentList 'start' -WindowStyle Hidden }
  else { Start-Process npm -ArgumentList 'start' -WindowStyle Hidden }
  Pop-Location
  Start-Sleep -Seconds 3
  Start-Process 'http://localhost:18789'
  Write-Ok 'Prowl is running! Dashboard opened.'
}
Stop-Transcript | Out-Null
Write-Host ''
