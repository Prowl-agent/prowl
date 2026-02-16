# Prowl Roadmap

## Current Status: Alpha (v0.1.x)

Core infrastructure is built. Focus is on wiring features end-to-end
and validating the model optimizer through benchmarks.

## Phase 1: Foundation (✅ Complete)

- [x] Fork architecture with clean upstream isolation (6 modified files)
- [x] Boot shim (prowl-shim.ts) with env var mapping
- [x] Hardware detection (Apple Silicon, NVIDIA, cross-platform)
- [x] Model recommendation based on hardware
- [x] HuggingFace model bridge with auto-quantization selection
- [x] One-command installers (macOS, Linux, Windows, npx)
- [x] Cost savings tracker with cloud provider comparisons
- [x] Smart task router (local-first, optional cloud fallback)
- [x] Model prompt optimizer (tier-aware prompts, 615 LOC)
- [x] Benchmark suite (30 tasks, 5 categories)
- [x] Visual model manager UI
- [x] Privacy dashboard
- [x] Cost savings dashboard
- [x] Setup wizard

## Phase 2: End-to-End Wiring (🔄 In Progress)

- [ ] Wire optimizer into live inference pipeline
- [ ] Wire task router into agent execution path
- [ ] Optimize streaming for fast token delivery
- [ ] Connect dashboard to real inference data
- [ ] Validate optimizer via benchmark results
- [ ] Integration tests for full flow

## Phase 3: Polish & Ship (Upcoming)

- [ ] Prowl Pro native Mac app shell
- [ ] npx create-prowl published to npm
- [ ] prowl.dev website live
- [ ] Benchmark results published (proves optimizer works)
- [ ] Migration guide from cloud APIs
- [ ] Discord community launch

## Phase 4: Growth

- [ ] Prowl Pro tier ($19/mo) — native Mac app, hybrid routing
- [ ] Prowl Cloud tier ($39-99/mo) — managed hosting
- [ ] Enterprise tier — air-gapped deployments
- [ ] Plugin marketplace for community extensions

## Key Metrics to Track

- Time-to-first-token on Qwen3 8B (target: <500ms)
- Benchmark score improvement (optimizer vs baseline)
- Install success rate (target: >95% one-command)
- Monthly cost savings per user (target: >$50 displayed)
