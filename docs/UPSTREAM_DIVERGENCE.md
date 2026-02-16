# Upstream Divergence Tracking

Prowl is a fork of [OpenClaw](https://github.com/openclaw/openclaw) focused on
local-first AI. This document tracks every file that differs from upstream so
that future merges stay predictable.

Last upstream commit merged: `upstream/main` at tag **v2026.2.14**
Last sync date: **2026-02-15**

---

## Modified Upstream Files (6)

These files exist in upstream and contain Prowl-specific changes. During an
upstream merge, conflicts will appear here and must be resolved manually.

### 1. `src/entry.ts` (+1 line)

**What:** Imports the Prowl boot shim before any other local module.

```
import "./prowl-shim.js"; // Prowl boot shim
```

**Why:** The shim must run first to sync `PROWL_*` env vars to `OPENCLAW_*`
before any config or defaults code reads them.

**Isolatable?** No — must be the first import in the process entry point.

### 2. `src/cli/run-main.ts` (+3 lines)

**What:** Imports `syncProwlEnv` and re-invokes it after `.env` loading.
Also changes the uncaught exception prefix from `[openclaw]` to `[prowl]`.

**Why:** `.env` files may set `PROWL_*` variables that need to be synced to
`OPENCLAW_*` after `loadDotEnv()` parses them.

**Isolatable?** The re-sync call is necessary. The `[prowl]` prefix is cosmetic
and could be reverted if it causes merge friction.

### 3. `src/agents/defaults.ts` (3 lines changed)

**What:** Makes `DEFAULT_PROVIDER` and `DEFAULT_MODEL` env-var-driven via
`process.env.OPENCLAW_DEFAULT_PROVIDER ?? "anthropic"`.

**Why:** Allows the boot shim to inject Prowl defaults (ollama / qwen3:8b)
without hardcoding them here. Upstream defaults still apply when no env var
is set.

**Isolatable?** Partially — if upstream ever makes these configurable via env
vars, this change can be dropped.

### 4. `src/plugins/config-state.ts` (+1 line)

**What:** Adds `"prowl-local"` to the `BUNDLED_ENABLED_BY_DEFAULT` set.

**Why:** The prowl-local extension plugin must be enabled automatically on
fresh installs. Without this, users would have to manually run
`openclaw plugins enable prowl-local` before the Prowl dashboard works.

**Isolatable?** Could be replaced by an install-time config write, but the
`BUNDLED_ENABLED_BY_DEFAULT` mechanism is the standard upstream pattern used
by `device-pair`, `phone-control`, and `talk-voice`.

### 5. `ui/src/ui/app.ts` (~10 lines changed)

**What:** Adds imports for 4 Prowl dashboard widget web components
(`cost-savings-widget.tsx`, `dashboard-shell-widget.tsx`,
`model-manager-widget.tsx`, `privacy-dashboard-widget.tsx`). Also renames
`normalizeAssistantIdentity` to `resolveInjectedAssistantIdentity` and
changes the global window property to `__PROWL_CONTROL_UI_BASE_PATH__`.

**Why:** The Prowl dashboard UI widgets need to be registered in the control
UI entry point so they render in the web interface.

**Isolatable?** The widget imports could potentially be moved to a dynamic
loader, but the rename and global property changes are intentional branding.

### 6. `vitest.config.ts` (~5 lines changed)

**What:** Adds `packages/core/src/**/*.test.ts` to the test include pattern
and replaces the `test/**/*.test.ts` glob with a specific file reference.

**Why:** Prowl's `packages/core/` test suite must be included in CI. The
upstream `test/` glob was narrowed to avoid picking up Prowl-specific test
fixtures.

**Isolatable?** Yes — could be replaced by a separate vitest config for
Prowl-specific tests, but one config is simpler.

---

## Prowl-Added Files (not in upstream)

These files exist only in the Prowl fork. Upstream merges will never conflict
with them.

### Boot shim

- `src/prowl-shim.ts` — syncs `PROWL_*` → `OPENCLAW_*` env vars, sets defaults

### Extension plugin

- `extensions/prowl-local/index.ts` — plugin registration (HTTP routes)
- `extensions/prowl-local/src/http-routes.ts` — route handler implementations
- `extensions/prowl-local/package.json` — plugin package metadata
- `extensions/prowl-local/openclaw.plugin.json` — plugin manifest

### Core packages

- `packages/core/src/analytics/` — cost tracking and savings calculations
- `packages/core/src/models/` — model management (list, pull, switch, delete, HF bridge)
- `packages/core/src/privacy/` — privacy audit log and statistics
- `packages/core/src/router/` — local-first task routing with cloud fallback
- `packages/core/src/setup/` — hardware detection, model recommendation, installer
- `packages/core/src/optimizer/` — model prompt optimization
- `packages/core/src/index.ts` — barrel export

### UI components

- `ui/src/ui/components/ModelManager.tsx` — model management dashboard
- `ui/src/ui/components/PrivacyDashboard.tsx` — privacy tracking dashboard
- `ui/src/ui/components/CostSavings.tsx` — cost savings display
- `ui/src/ui/components/SetupWizard.tsx` — first-run setup wizard
- `ui/src/ui/components/AppShell.tsx` — dashboard layout shell
- `ui/src/ui/components/DashboardShell.tsx` — dashboard container
- `ui/src/ui/components/*-widget.tsx` — web component wrappers (4 files)
- `ui/src/ui/components/*.test.tsx` — component tests (4 files)

### CLI commands

- `src/commands/models/hf-install.ts` — HuggingFace model install command
- `src/commands/models/pricing.ts` — cloud pricing management command
- `src/agents/ollama-config.ts` — Ollama configuration helper

### Config

- `src/config/types.prowl.ts` — Prowl-specific config type extensions

### Install and scripts

- `install.sh` — one-command installer
- `scripts/check-*.ts` — development check scripts (12 files)

### Tests (Prowl-only)

- `src/infra/ports-inspect.test.ts` — port inspector tests
- `src/commands/models/hf-install.test.ts` — HF install command tests
- `src/commands/models/pricing.test.ts` — pricing command tests

### Documentation

- `docs/architecture.md` — Prowl architecture overview
- `docs/UPSTREAM_DIVERGENCE.md` — this file

---

## Merge Conflict Resolution Guide

When merging `upstream/main`:

1. Run `scripts/sync-upstream.sh` (or manually fetch + merge)
2. Expect conflicts in the 6 modified files listed above
3. For each conflict, keep the Prowl additions alongside upstream changes
4. Build (`pnpm build`) and test (`pnpm test`) after resolving
5. Update the "Last upstream commit" and date at the top of this file

### Conflict patterns

| File                          | Typical conflict                   | Resolution                            |
| ----------------------------- | ---------------------------------- | ------------------------------------- |
| `src/entry.ts`                | Upstream adds imports before/after | Keep shim import as first line        |
| `src/cli/run-main.ts`         | Upstream changes near `loadDotEnv` | Keep `syncProwlEnv()` call after it   |
| `src/agents/defaults.ts`      | Upstream changes default model     | Keep env-var pattern, update fallback |
| `src/plugins/config-state.ts` | Upstream adds to default set       | Keep `prowl-local` in the set         |
| `ui/src/ui/app.ts`            | Upstream changes imports/globals   | Keep widget imports and Prowl globals |
| `vitest.config.ts`            | Upstream changes test includes     | Keep `packages/core/` in includes     |
