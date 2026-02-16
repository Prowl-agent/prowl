#!/usr/bin/env bash
set -euo pipefail

# ── Windows redirect ─────────────────────────────────────────────────
if [[ "${OSTYPE:-}" == "msys" || "${OSTYPE:-}" == "cygwin" ]]; then
  echo "Windows detected. Please use PowerShell instead:"
  echo "  irm https://prowl.dev/install.ps1 | iex"
  exit 1
fi

PROWL_VERSION="0.1.0"
PROWL_REPO="https://github.com/prowl-agent/prowl"
PROWL_DIR="${HOME}/.prowl/app"
PROWL_CONFIG="${HOME}/.prowl/config.json"
PROWL_LOG="${HOME}/.prowl/install.log"
PROWL_MODEL=""
mkdir -p "${HOME}/.prowl"
exec > >(tee -a "${PROWL_LOG}") 2>&1

# ── colors (auto-detect) ────────────────────────────────────────────
G="" Y="" R="" C="" B="" X=""
if [[ -t 1 ]] && command -v tput &>/dev/null && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' C=$'\033[36m' B=$'\033[1m' X=$'\033[0m'
fi
ok()   { printf "  %s✅ %s%s\n" "$G" "$*" "$X"; }
warn() { printf "  %s⚠️  %s%s\n" "$Y" "$*" "$X"; }
info() { printf "  %s→  %s%s\n" "$C" "$*" "$X"; }
die()  { printf "  %s❌ %s%s\n" "$R" "$*" "$X" >&2; exit 1; }

echo ""
echo "  ${B}🐾 Prowl ${PROWL_VERSION}${X}"
echo "     Your AI agent. Your hardware. Zero cost."
echo ""

# ── idempotency: detect existing install ─────────────────────────────
if [[ -f "$PROWL_CONFIG" && -d "${PROWL_DIR}/.git" ]]; then
  cur=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROWL_CONFIG" 2>/dev/null | head -1 | sed 's/.*"//') || true
  echo "  ${B}Existing install detected${X} (model: ${cur:-?})"
  printf "  Update to latest? (Y/n) "; read -r r < /dev/tty 2>/dev/null || r="y"
  [[ "${r:-y}" =~ ^[Nn] ]] && { echo "  No changes made."; exit 0; }; echo ""
fi

install_node() {
  if [[ "${OSTYPE:-}" == darwin* ]] && command -v brew &>/dev/null; then
    brew install node@22 >>"$PROWL_LOG" 2>&1 || true
    brew link --force --overwrite node@22 >>"$PROWL_LOG" 2>&1 || true
  else
    curl -fsSL https://fnm.vercel.app/install | bash >>"$PROWL_LOG" 2>&1
    export PATH="${HOME}/.local/share/fnm:${PATH}"
    eval "$(fnm env 2>/dev/null)"; fnm install 22 && fnm use 22
  fi
}

# ── [1/5] Node.js ────────────────────────────────────────────────────
printf "  ${B}[1/5]${X} Checking Node.js...           "
if command -v node &>/dev/null; then
  nv=$(node -e "process.stdout.write(process.version)")
  nm=$(node -e "process.stdout.write(process.version.split('.')[0].replace('v',''))")
  if [[ "$nm" -ge 22 ]]; then ok "$nv found"
  else echo ""; info "Found $nv, need 22+. Upgrading..."; install_node; ok "Node.js $(node -v)"; fi
else
  echo ""; info "Not found. Installing..."; install_node
  command -v node &>/dev/null || die "Node.js 22+ required. Install from https://nodejs.org or: brew install node"
  ok "Node.js $(node -v)"
fi

# ── [2/5] Ollama ─────────────────────────────────────────────────────
printf "  ${B}[2/5]${X} Checking Ollama...            "
if command -v ollama &>/dev/null; then
  ok "$(ollama --version 2>/dev/null | head -1 || echo installed)"
else
  printf "📦 Installing...  "
  if [[ "${OSTYPE:-}" == darwin* ]] && command -v brew &>/dev/null; then
    brew install ollama >>"$PROWL_LOG" 2>&1 || curl -fsSL https://ollama.com/install.sh | sh >>"$PROWL_LOG" 2>&1
  else curl -fsSL https://ollama.com/install.sh | sh >>"$PROWL_LOG" 2>&1; fi
  command -v ollama &>/dev/null || die "Ollama install failed. See $PROWL_LOG"
  ok "installed"
fi
if ! curl -sf http://localhost:11434/ &>/dev/null; then
  info "Starting Ollama..."; ollama serve >>"$PROWL_LOG" 2>&1 &
  for _ in $(seq 1 15); do sleep 1; curl -sf http://localhost:11434/ &>/dev/null && break; done
  curl -sf http://localhost:11434/ &>/dev/null || die "Could not start Ollama. Run 'ollama serve' manually."
fi

# ── [3/5] Hardware ───────────────────────────────────────────────────
printf "  ${B}[3/5]${X} Detecting hardware...         "
if [[ "${OSTYPE:-}" == darwin* ]]; then
  ram_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null | sed 's/([^)]*)//g' | cut -c1-40 | xargs)
else
  ram_gb=$(( ($(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0) * 1024) / 1073741824 ))
  chip=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | cut -c1-40 | xargs || echo "CPU")
fi
printf "🖥️  %s, %sGB RAM\n" "${chip:-Unknown}" "$ram_gb"

# ── [4/5] Pull model ────────────────────────────────────────────────
avail=$(( ram_gb - 6 ))
if   [[ $avail -ge 40 ]]; then PROWL_MODEL="qwen3:32b";         ml="Qwen3 32B"
elif [[ $avail -ge 14 ]]; then PROWL_MODEL="qwen2.5-coder:14b"; ml="Qwen2.5-Coder 14B"
elif [[ $avail -ge  8 ]]; then PROWL_MODEL="qwen3:8b";          ml="Qwen3 8B"
elif [[ $avail -ge  4 ]]; then PROWL_MODEL="qwen3:4b";          ml="Qwen3 4B"
else die "Insufficient memory (${ram_gb}GB). At least 10GB RAM required."; fi

printf "  ${B}[4/5]${X} Pulling AI model...           ⬇️  %s\n" "$ml"
if ollama list 2>/dev/null | grep -q "^${PROWL_MODEL}"; then
  ok "${PROWL_MODEL} already installed"
else
  ollama pull "$PROWL_MODEL" 2>&1 | while IFS= read -r line; do
    pct=$(echo "$line" | grep -o '[0-9]\{1,3\}%' | tail -1 || true)
    [[ -n "$pct" ]] && printf "\r         ⬇️  %s  %s   " "$PROWL_MODEL" "$pct"
  done; printf "\n"; ok "${PROWL_MODEL} ready"
fi

# ── [5/5] Install / update ──────────────────────────────────────────
printf "  ${B}[5/5]${X} Setting up Prowl...           "
if [[ -d "${PROWL_DIR}/.git" ]]; then
  git -C "$PROWL_DIR" pull --ff-only origin main >>"$PROWL_LOG" 2>&1 || warn "Update skipped"
else
  mkdir -p "$(dirname "$PROWL_DIR")"
  git clone --depth 1 "$PROWL_REPO" "$PROWL_DIR" >>"$PROWL_LOG" 2>&1
fi
cd "$PROWL_DIR"
if command -v pnpm &>/dev/null; then pnpm install --frozen-lockfile >>"$PROWL_LOG" 2>&1 || pnpm install >>"$PROWL_LOG" 2>&1
else npm install >>"$PROWL_LOG" 2>&1; fi
ok "Ready!"

# ── config + alias ───────────────────────────────────────────────────
[[ -f "$PROWL_CONFIG" ]] || cat > "$PROWL_CONFIG" <<JSON
{"model":"${PROWL_MODEL}","ollamaUrl":"http://localhost:11434","installedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","prowlVersion":"${PROWL_VERSION}"}
JSON
mk="# prowl-agent"; al="alias prowl='cd ${PROWL_DIR} && pnpm start gateway run --allow-unconfigured'"
for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile"; do
  [[ -f "$rc" ]] && ! grep -q "$mk" "$rc" && { echo ""; echo "$mk"; echo "$al"; } >> "$rc"
done

# ── done ─────────────────────────────────────────────────────────────
echo ""
echo "  ${B}${G}🐾 Prowl is ready!${X}"
echo ""
echo "     Dashboard:  ${C}http://localhost:18789${X}"
echo "     Docs:       ${C}https://prowl.dev/docs${X}"
echo "     Log:        ${PROWL_LOG}"
echo ""
echo "     ${Y}💰 Savings vs GPT-4o: \$0.00 and counting${X}"
echo ""

# ── auto-start ───────────────────────────────────────────────────────
printf "  Start Prowl now? (Y/n) "
read -r sr < /dev/tty 2>/dev/null || sr="y"
if [[ "${sr:-y}" =~ ^[Yy]|^$ ]]; then
  echo ""; info "Starting Prowl..."
  cd "$PROWL_DIR"
  if command -v pnpm &>/dev/null; then pnpm start gateway run --allow-unconfigured & else npm start gateway run --allow-unconfigured & fi
  sleep 3; url="http://localhost:18789"
  if [[ "${OSTYPE:-}" == darwin* ]]; then open "$url" 2>/dev/null || true
  elif command -v xdg-open &>/dev/null; then xdg-open "$url" 2>/dev/null || true; fi
  ok "Prowl is running! Dashboard opened."
fi
echo ""
