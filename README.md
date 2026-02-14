# 🐾 Prowl

**Your AI agent. Your hardware. Zero cost.**

> OpenClaw charges $50-200/month in API fees.
> Prowl runs the same agent on your Mac for free.

![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-22+-brightgreen)
![pnpm](https://img.shields.io/badge/pnpm-workspace-orange)
![local-first](https://img.shields.io/badge/local--first-yes-10B981?color=10B981)

## Quick Start

```bash
curl -fsSL https://prowl.dev/install | bash
```

One command. Auto-detects your hardware. Installs Ollama if needed.
Pulls the right model for your machine. Done in under 2 minutes.

## Why Prowl?

|                     | Prowl     | OpenClaw | Claude Code |
| ------------------- | --------- | -------- | ----------- |
| Monthly cost        | **$0**    | $50–200  | $20+        |
| Data leaves machine | **Never** | Always   | Always      |
| Works offline       | **Yes**   | No       | No          |
| Setup time          | **2 min** | 10+ min  | 5 min       |

## Hardware Support

| Hardware                     | RAM       | Model             | Quality              |
| ---------------------------- | --------- | ----------------- | -------------------- |
| Mac Mini M4 / MacBook Air M4 | 16GB      | Qwen3 8B          | ⭐⭐⭐ Good          |
| Mac Mini M4 Pro              | 24GB      | Qwen2.5-Coder 14B | ⭐⭐⭐⭐ Great       |
| Mac Studio M4 Max            | 64GB+     | Qwen3 32B         | ⭐⭐⭐⭐⭐ Excellent |
| Any PC + RTX 3060            | 12GB VRAM | Qwen3 8B          | ⭐⭐⭐ Good          |
| Any PC + RTX 4090            | 24GB VRAM | Qwen3 32B         | ⭐⭐⭐⭐⭐ Excellent |

## What's Inside

### One-command install

Prowl handles setup from a single command so you do not have to manage toolchains manually. It detects your machine profile, installs Ollama if it is missing, and applies sane defaults out of the box. The installer selects the best starting model for your available RAM and writes a clean local config. You skip API keys, cloud account setup, and hand-editing config files.

### Smart model selection

Model selection is based on real hardware checks, not generic presets. On macOS, Prowl reads system memory directly and optimizes for Apple Silicon runtime behavior. On Linux, it evaluates available memory and GPU context to avoid unstable model picks. The result is a model choice that launches reliably and gives the best quality your hardware can sustain.

### Cost savings tracker

Prowl keeps a live tally of what your local usage would have cost on hosted APIs. It tracks inference activity and compares it against reference pricing for GPT-4o and Claude Sonnet style workloads. You get immediate feedback on savings growth as you keep using local models. The tracker is built to make local-first economics visible from day one.

### Privacy dashboard

The privacy dashboard makes your data path explicit on every run. It includes a streak counter for consecutive local-only sessions and surfaces when traffic stays on-device. You can inspect a simple data flow diagram and validate where requests are processed. Full audit log export is included so teams can retain proof for internal review.

### Visual model manager

The model manager provides a UI to install, switch, and remove models without shell commands. Downloads stream with progress feedback so you can monitor large pulls in real time. Active model switching is fast, making it practical to move between speed and quality profiles. This keeps model operations accessible while still preserving full local control.

### HuggingFace model support

Prowl can search HuggingFace repositories and guide GGUF selection for your hardware limits. It automatically prefers quantizations like Q4_K_M or Q8_0 based on available RAM and practical runtime fit. After selection, it handles registration with Ollama so models appear in your local catalog. This gives power users flexible model sourcing without a fragile manual conversion workflow.

## Business Model

| Tier            | Price      | What you get                              |
| --------------- | ---------- | ----------------------------------------- |
| **Free**        | $0 forever | Full Prowl, self-hosted, MIT license      |
| **Prowl Pro**   | $19/mo     | Native Mac app, team features, analytics  |
| **Prowl Cloud** | $39–99/mo  | Managed hosting, no self-hosting required |
| **Enterprise**  | Custom     | Air-gapped, compliance, SLA               |

> The free tier is not a trial. It's the full product.

## Development

```bash
git clone https://github.com/prowl-agent/prowl
cd prowl
pnpm install
pnpm build
npx tsx scripts/check-all.ts   # verify everything works
```

**Requirements:** Node.js 22+, pnpm, Ollama

## Contributing

PRs welcome. Please read CONTRIBUTING.md first.
Each PR should have: one feature, tests, passing build.

## Acknowledgements

Prowl is a fork of [OpenClaw](https://github.com/openclaw/openclaw) (MIT).
Huge thanks to the OpenClaw team for building the foundation this runs on.
