# Installing Prowl

Prowl runs entirely on your hardware using local AI models via [Ollama](https://ollama.com). No cloud accounts, no API keys, no subscriptions. This guide covers every installation method from "never opened a terminal" to "I have opinions about package managers."

## Requirements

| Requirement | Minimum                            | Recommended             |
| ----------- | ---------------------------------- | ----------------------- |
| RAM         | 10 GB                              | 16 GB+                  |
| Disk        | 8 GB free                          | 20 GB free              |
| OS          | macOS 13+, Ubuntu 20+, Windows 10+ | macOS (Apple Silicon)   |
| Node.js     | 22+                                | Installed automatically |
| Ollama      | Latest                             | Installed automatically |

Prowl auto-detects your hardware and selects the best model. You don't need to decide anything upfront.

---

## Method 1: One-Line Install (macOS / Linux)

Open Terminal (macOS: press `Cmd + Space`, type "Terminal", press Enter) and paste:

```bash
curl -fsSL https://prowl.dev/install | bash
```

**What happens:**

```
  [1/5] Checking Node.js...           ✅ v22.12.0 found
  [2/5] Checking Ollama...            ✅ ollama version 0.5.1
  [3/5] Detecting hardware...         🖥️  Apple M4, 16GB RAM
  [4/5] Pulling AI model...           ⬇️  Qwen3 8B  81%
  [5/5] Setting up Prowl...           ✅ Ready!

  🐾 Prowl is ready!
  Start Prowl now? (Y/n)
```

The installer:

- Installs Node.js 22 if missing (via Homebrew on Mac, fnm on Linux)
- Installs Ollama if missing (via Homebrew or the official installer)
- Detects your CPU, RAM, and GPU
- Selects and downloads the best model for your hardware (2-5 GB)
- Clones Prowl and installs dependencies
- Offers to launch immediately with the dashboard in your browser

**Running it again?** The installer is idempotent. If Prowl is already installed, it asks if you want to update instead of reinstalling.

**Logs:** Everything is logged to `~/.prowl/install.log` for troubleshooting.

---

## Method 2: One-Line Install (Windows)

Open PowerShell (press `Win + X`, select "Terminal" or "PowerShell") and paste:

```powershell
irm https://prowl.dev/install.ps1 | iex
```

This does the same thing as the macOS/Linux installer but uses `winget` for Node.js and Ollama. If you have an NVIDIA RTX GPU, the installer detects it and may recommend a larger model.

---

## Method 3: npx (Node.js users)

If you already have Node.js 22+ installed:

```bash
npx create-prowl
```

This gives you a richer interactive experience with spinners, progress bars, and a preview of what will be installed before anything runs. It's the same steps as the shell installer but with a nicer TUI.

---

## Method 4: Manual Setup (Developers)

For contributors or anyone who wants full control:

### Prerequisites

Install these first:

- [Node.js 22+](https://nodejs.org) (or `brew install node@22`)
- [pnpm](https://pnpm.io/installation) (or `npm install -g pnpm`)
- [Ollama](https://ollama.com) (or `brew install ollama`)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/prowl-agent/prowl
cd prowl

# 2. Install dependencies
pnpm install

# 3. Build
pnpm build

# 4. Start Ollama and pull a model
ollama serve &          # skip if Ollama is already running
ollama pull qwen3:8b    # or qwen2.5-coder:14b for 24GB+ RAM

# 5. Run Prowl
pnpm start
```

The dashboard opens at [http://localhost:18789](http://localhost:18789).

### Development Commands

| Command              | What it does                         |
| -------------------- | ------------------------------------ |
| `pnpm dev`           | Run in development mode              |
| `pnpm build`         | Full production build                |
| `pnpm test`          | Run tests (Vitest)                   |
| `pnpm test:coverage` | Run tests with coverage              |
| `pnpm tsgo`          | TypeScript type-check                |
| `pnpm check`         | Lint + format check (Oxlint + Oxfmt) |
| `pnpm format`        | Auto-format code                     |

---

## After Installation

### First Launch

You do **not** need to run `prowl setup` before starting. The gateway starts without an existing config file and creates a minimal one automatically so the dashboard and setup wizard work on first run.

On first launch, Prowl automatically opens the dashboard at `http://localhost:18789` in your browser. If it doesn't open automatically, navigate there manually.

### What Gets Installed Where

| Path                   | Contents                                                  |
| ---------------------- | --------------------------------------------------------- |
| `~/.prowl/app/`        | Prowl source code                                         |
| `~/.prowl/config.json` | Your configuration (model, Ollama URL)                    |
| `~/.prowl/install.log` | Installer log for troubleshooting                         |
| `~/.prowl/benchmarks/` | Benchmark results (if you run benchmarks)                 |
| Ollama models          | Stored in Ollama's default location (`~/.ollama/models/`) |

### Starting Prowl After Installation

```bash
prowl                    # if the shell alias was added (runs gateway with first-run support)
# or
cd ~/.prowl/app && pnpm start gateway run --allow-unconfigured
```

The alias and installer use `--allow-unconfigured` so the gateway starts even when no config file exists yet (e.g. first time or after a clean install). The dashboard is always at [http://localhost:18789](http://localhost:18789).

### Changing Your Model

Prowl selects a model during installation, but you can switch at any time:

```bash
ollama pull qwen2.5-coder:14b    # download a different model
```

Then switch in the dashboard under Model Management, or edit `~/.prowl/config.json`:

```json
{
  "model": "qwen2.5-coder:14b"
}
```

---

## Model Selection Guide

The installer picks a model based on your available RAM. Here's what it chooses and why:

| Available RAM | Model             | Download Size | Quality   | Speed       |
| ------------- | ----------------- | ------------- | --------- | ----------- |
| 40 GB+        | Qwen3 32B         | ~20 GB        | Excellent | 8-12 tok/s  |
| 14-39 GB      | Qwen2.5-Coder 14B | ~9 GB         | Great     | 10-15 tok/s |
| 8-13 GB       | Qwen3 8B          | ~5 GB         | Good      | 15-20 tok/s |
| 4-7 GB        | Qwen3 4B          | ~3 GB         | Basic     | 20-30 tok/s |

"Available RAM" is total RAM minus 6 GB reserved for the OS and other apps.

**Apple Silicon users:** Your unified memory is shared between CPU and GPU. A 16 GB MacBook Air effectively has ~10 GB available for models, which gets you Qwen3 8B.

**NVIDIA GPU users:** If you have an RTX 3060+ with 12 GB+ VRAM, you can run larger models than your system RAM alone would suggest. The installer accounts for this on Windows.

---

## Benchmarking Your Setup

After installation, verify your setup with the benchmark suite:

```bash
# Run all benchmarks with your current model
prowl benchmark

# Run a specific category
prowl benchmark --category code-gen

# Compare with and without the prompt optimizer
prowl benchmark --models qwen3:8b --runs 3

# List available benchmark tasks
prowl benchmark --list
```

Results are saved to `~/.prowl/benchmarks/` as JSON and a human-readable `BENCHMARK.md`.

---

## Troubleshooting

### "Node.js not found"

Install Node.js 22 from [nodejs.org](https://nodejs.org) or:

- macOS: `brew install node@22`
- Linux: `curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22`
- Windows: `winget install OpenJS.NodeJS.LTS`

### "Ollama is not running"

Start Ollama:

- macOS: open the Ollama app, or `ollama serve`
- Linux: `ollama serve`
- Windows: open Ollama from Start menu, or `ollama serve`

### "Insufficient memory"

Prowl requires at least 10 GB RAM. If you have 8 GB, you can try forcing a smaller model:

```bash
ollama pull qwen3:4b
```

But expect limited quality.

### "Model pull is stuck / slow"

Large models (5+ GB) take time to download. The progress indicator updates every few seconds. If it appears stuck:

1. Check your internet connection
2. Try `Ctrl+C` and run the installer again (it resumes where it left off)
3. Pull manually: `ollama pull qwen3:8b`

### "Dashboard won't open"

Navigate to [http://localhost:18789](http://localhost:18789) manually. If nothing loads, check that Prowl is running:

```bash
curl http://localhost:18789/api/health
```

### Getting Help

- Check `~/.prowl/install.log` for detailed output
- Open an issue at [github.com/prowl-agent/prowl/issues](https://github.com/prowl-agent/prowl/issues)
- Include your OS, RAM, and the contents of `install.log`

---

## Uninstalling

```bash
# Remove Prowl
rm -rf ~/.prowl

# Remove Ollama models (optional — keeps Ollama itself)
rm -rf ~/.ollama/models

# Remove the shell alias
# Edit ~/.zshrc or ~/.bashrc and remove the "# prowl-agent" lines
```

To uninstall Ollama itself, follow [Ollama's uninstall guide](https://github.com/ollama/ollama#uninstall).
