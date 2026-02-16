# Prowl

**Your AI agent. Your hardware. Zero cost.**

Prowl is a local-first AI agent framework that runs entirely on your machine using open-source models. No API keys. No cloud. No monthly bill. One command to install, under 3 minutes to get running.

![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-22+-brightgreen)
![pnpm](https://img.shields.io/badge/pnpm-workspace-orange)
![local-first](https://img.shields.io/badge/local--first-yes-10B981?color=10B981)

## Quick Start

**macOS / Linux** — open Terminal and paste:

```bash
curl -fsSL https://prowl.dev/install | bash
```

**Windows** — open PowerShell and paste:

```powershell
irm https://prowl.dev/install.ps1 | iex
```

**Already have Node.js?**

```bash
npx create-prowl
```

The installer auto-detects your hardware, installs [Ollama](https://ollama.com) if needed, pulls the right model for your machine, and opens the dashboard in your browser. Done.

> For detailed installation options, troubleshooting, and manual setup, see the **[Installation Guide](docs/INSTALL.md)**.

## Why Prowl?

|                     | Prowl     | Cloud AI (GPT-4o, Claude) |
| ------------------- | --------- | ------------------------- |
| Monthly cost        | **$0**    | $20-200                   |
| Data leaves machine | **Never** | Always                    |
| Works offline       | **Yes**   | No                        |
| Setup time          | **2 min** | Account + billing setup   |
| Vendor lock-in      | **None**  | Yes                       |

## Hardware Support

Prowl automatically selects the best model for your machine:

| Hardware                          | RAM    | Model             | Quality   | Speed       |
| --------------------------------- | ------ | ----------------- | --------- | ----------- |
| Mac Studio M4 Max / PC + RTX 4090 | 64 GB+ | Qwen3 32B         | Excellent | 8-12 tok/s  |
| Mac Mini M4 Pro / PC + RTX 3060   | 24 GB  | Qwen2.5-Coder 14B | Great     | 10-15 tok/s |
| MacBook Air M4 / Most laptops     | 16 GB  | Qwen3 8B          | Good      | 15-20 tok/s |
| Older machines                    | 10 GB  | Qwen3 4B          | Basic     | 20-30 tok/s |

Apple Silicon users benefit from unified memory — your full RAM is available for models. NVIDIA GPU users get VRAM-aware model selection on Windows.

## What Prowl Does

### Local AI Agent

Prowl runs a full-featured AI agent on your hardware through [Ollama](https://ollama.com) and open-source models. It handles code editing, generation, tool use, reasoning, and documentation tasks — the same kinds of work you'd use GPT-4 or Claude for, but running privately on your machine.

### Model Prompt Optimizer

The optimizer automatically tunes prompts and inference parameters for your specific model. It applies tier-aware system prompts (small/medium/large models get different instructions), task-specific sampling settings (lower temperature for code, higher for creative work), and context management strategies. The result: better output from the same model, without manual prompt engineering.

### Benchmark Suite

Prowl includes a benchmark framework to measure how well models perform on agent tasks, and how much the optimizer helps. 30 tasks across 5 categories (code editing, code generation, tool use, reasoning, documentation) with automated scoring and an LLM-as-judge fallback.

```bash
prowl benchmark                          # run all benchmarks
prowl benchmark --category code-gen      # specific category
prowl benchmark --models qwen3:8b --runs 3  # multiple runs for statistical significance
```

Results are exported as formatted console output, Markdown reports, and JSON for historical tracking.

### Multi-Channel Gateway

Built on [OpenClaw](https://github.com/openclaw/openclaw)'s gateway architecture, Prowl can connect your AI agent to messaging channels — Telegram, Discord, Slack, Signal, WhatsApp, and [30+ more](extensions/) via the plugin system. The gateway handles WebSocket communication, message routing, and channel management.

### Privacy and Cost Tracking

The privacy dashboard shows where your data goes (nowhere — it stays on your machine). A cost savings tracker estimates what your local usage would cost on hosted APIs, making the economics visible from day one.

### Plugin System

Prowl's functionality is extensible through plugins in the `extensions/` directory. The `prowl-local` plugin provides model management, privacy tracking, cost savings, hardware detection, and the benchmark CLI. Third-party plugins can register HTTP routes, CLI commands, and messaging channel integrations.

## Architecture

```
prowl/
├── src/                    # Core: CLI, gateway, config, channels, agents
│   ├── cli/                # CLI command registration and wiring
│   ├── gateway/            # WebSocket gateway server
│   ├── config/             # Configuration management
│   ├── channels/           # Messaging channel abstractions
│   └── agents/             # Agent execution and workspace management
├── packages/
│   └── core/               # Prowl-specific core modules
│       └── src/
│           ├── setup/      # Hardware detection, model recommendation, installer
│           ├── optimizer/  # Model prompt optimizer (615 LOC)
│           └── benchmark/  # Benchmark suite: tasks, scorer, runner, reporter
├── extensions/
│   ├── prowl-local/        # Prowl dashboard routes + benchmark CLI
│   └── ...                 # 30+ channel and feature plugins
├── ui/                     # Web dashboard (React)
├── apps/                   # Native apps (macOS, iOS, Android)
├── install.sh              # macOS/Linux installer
├── install.ps1             # Windows installer
└── packages/create-prowl/  # npx create-prowl package
```

Key design decisions:

- **Prowl-specific code** lives in `packages/core/` and `extensions/prowl-local/`, keeping the upstream OpenClaw core clean (only 6 modified upstream files).
- **Local-first** — Ollama for inference, no cloud API calls in the default path.
- **Plugin architecture** — new channels and features are self-contained extensions, not core patches.

## Development

```bash
git clone https://github.com/prowl-agent/prowl
cd prowl
pnpm install
pnpm build
```

| Command              | Description                    |
| -------------------- | ------------------------------ |
| `pnpm dev`           | Run in dev mode                |
| `pnpm build`         | Production build               |
| `pnpm test`          | Run tests (Vitest)             |
| `pnpm test:coverage` | Tests with V8 coverage         |
| `pnpm tsgo`          | TypeScript type-check          |
| `pnpm check`         | Lint + format (Oxlint + Oxfmt) |
| `pnpm format`        | Auto-format                    |

**Requirements:** Node.js 22+, pnpm 10+, Ollama

## Contributing

PRs welcome. Please read CONTRIBUTING.md first. Each PR should have one feature, tests, and a passing build. Run `pnpm check && pnpm test` before submitting.

## Business Model

| Tier            | Price      | What you get                              |
| --------------- | ---------- | ----------------------------------------- |
| **Free**        | $0 forever | Full Prowl, self-hosted, MIT license      |
| **Prowl Pro**   | $19/mo     | Native Mac app, team features, analytics  |
| **Prowl Cloud** | $39-99/mo  | Managed hosting, no self-hosting required |
| **Enterprise**  | Custom     | Air-gapped, compliance, SLA               |

> The free tier is not a trial. It's the full product.

## Acknowledgements

Prowl is a fork of [OpenClaw](https://github.com/openclaw/openclaw) (MIT). Huge thanks to the OpenClaw team for building the foundation this runs on.
