#!/usr/bin/env bash
set -euo pipefail

PROWL_VERSION="0.1.0"
PROWL_REPO="https://github.com/prowl-agent/prowl"
PROWL_DIR="${HOME}/.prowl/app"

echo ""
echo "🐾 Prowl ${PROWL_VERSION}"
echo "   Your AI agent. Your hardware. Zero cost."
echo ""

# ── helpers ──────────────────────────────────────────────────────────
step()  { echo "  → $*"; }
ok()    { echo "  ✅ $*"; }
warn()  { echo "  ⚠️  $*"; }
die()   { echo "  ❌ $*" >&2; exit 1; }

# ── 1. node 22+ ──────────────────────────────────────────────────────
check_node() {
  if command -v node &>/dev/null; then
    local major
    major=$(node -e "process.stdout.write(process.version.split('.')[0].replace('v',''))")
    if [[ "$major" -ge 22 ]]; then
      ok "Node.js $(node -v)"; return
    fi
  fi
  step "Installing Node.js 22..."
  if [[ "${OSTYPE:-}" == darwin* ]] && command -v brew &>/dev/null; then
    brew install node@22 2>/dev/null || true
  else
    curl -fsSL https://fnm.vercel.app/install | bash
    export PATH="${HOME}/.local/share/fnm:${PATH}"
    eval "$(fnm env 2>/dev/null)"
    fnm install 22 && fnm use 22
  fi
  ok "Node.js $(node -v)"
}

# ── 2. ollama ────────────────────────────────────────────────────────
check_ollama() {
  if command -v ollama &>/dev/null; then
    ok "Ollama $(ollama --version 2>/dev/null | head -1)"; return
  fi
  step "Installing Ollama..."
  if [[ "${OSTYPE:-}" == darwin* ]] && command -v brew &>/dev/null; then
    brew install ollama
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  ok "Ollama installed"
}

# ── 3. ensure ollama is running ───────────────────────────────────────
ensure_ollama_running() {
  if curl -sf http://localhost:11434/ &>/dev/null; then
    ok "Ollama is running"; return
  fi
  step "Starting Ollama..."
  ollama serve &>/dev/null &
  for _ in $(seq 1 12); do
    sleep 1
    curl -sf http://localhost:11434/ &>/dev/null && { ok "Ollama started"; return; }
  done
  die "Could not start Ollama. Run 'ollama serve' in a separate terminal and retry."
}

# ── 4. pick + pull model ─────────────────────────────────────────────
pull_model() {
  local ram_gb available model label
  if [[ "${OSTYPE:-}" == darwin* ]]; then
    local ram_bytes
    ram_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    ram_gb=$(( ram_bytes / 1073741824 ))
  else
    local ram_kb
    ram_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
    ram_gb=$(( (ram_kb * 1024) / 1073741824 ))
  fi
  available=$(( ram_gb - 6 ))

  if   [[ $available -ge 40 ]]; then model="qwen3:32b";          label="Qwen3 32B (excellent)"
  elif [[ $available -ge 14 ]]; then model="qwen2.5-coder:14b";  label="Qwen2.5-Coder 14B (great)"
  elif [[ $available -ge  8 ]]; then model="qwen3:8b";           label="Qwen3 8B (good)"
  elif [[ $available -ge  4 ]]; then model="qwen3:4b";           label="Qwen3 4B (basic)"
  else die "Insufficient memory. Prowl requires at least 16 GB RAM."; fi

  step "Detected ${ram_gb} GB RAM  →  ${label}"

  if ollama list 2>/dev/null | grep -q "^${model}"; then
    ok "Model ${model} already installed"
  else
    step "Pulling ${model} — this may take a few minutes..."
    ollama pull "${model}"
    ok "Model ready"
  fi
  PROWL_MODEL="${model}"
}

# ── 5. clone / update prowl ───────────────────────────────────────────
install_prowl() {
  if [[ -d "${PROWL_DIR}/.git" ]]; then
    step "Updating Prowl..."
    git -C "${PROWL_DIR}" pull --ff-only origin main 2>/dev/null || warn "Could not auto-update; continuing with existing version."
  else
    step "Installing Prowl..."
    mkdir -p "$(dirname "${PROWL_DIR}")"
    git clone "${PROWL_REPO}" "${PROWL_DIR}"
  fi
  cd "${PROWL_DIR}"
  if command -v pnpm &>/dev/null; then
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  else
    npm install
  fi
  ok "Prowl installed at ${PROWL_DIR}"
}

# ── 6. write config ───────────────────────────────────────────────────
write_config() {
  local cfg="${HOME}/.prowl/config.json"
  mkdir -p "$(dirname "${cfg}")"
  if [[ ! -f "${cfg}" ]]; then
    cat > "${cfg}" <<JSON
{
  "model": "${PROWL_MODEL}",
  "ollamaUrl": "http://localhost:11434",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "prowlVersion": "${PROWL_VERSION}"
}
JSON
    ok "Config written"
  else
    ok "Config already exists"
  fi
}

# ── 7. shell alias ────────────────────────────────────────────────────
add_alias() {
  local marker="# prowl-agent"
  local line="alias prowl='cd ${PROWL_DIR} && pnpm start'"
  for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile"; do
    [[ -f "${rc}" ]] || continue
    grep -q "${marker}" "${rc}" && continue
    { echo ""; echo "${marker}"; echo "${line}"; } >> "${rc}"
  done
  ok "Shell alias added (restart terminal or run: source ~/.zshrc)"
}

# ── run ───────────────────────────────────────────────────────────────
check_node
check_ollama
ensure_ollama_running
pull_model
install_prowl
write_config
add_alias

echo ""
echo "  🐾 Prowl is ready!"
echo ""
echo "     Start:      cd ${PROWL_DIR} && pnpm start"
echo "     Dashboard:  http://localhost:18789"
echo "     Docs:       https://prowl.dev/docs"
echo ""
echo "     💰 Savings vs GPT-4o: \$0.00 and counting"
echo ""
