# Prowl Architecture

```
packages/core/src/
├── setup/        hardware-detect, model-recommend, installer
├── models/       model-manager, hf-bridge (HuggingFace GGUF)
├── analytics/    cost-tracker (savings vs cloud APIs)
├── privacy/      privacy-tracker (audit log, streak counter)
└── router/       task-router (local-first, optional cloud fallback)

ui/src/ui/
├── components/   React widgets mounted as Web Component islands
│   ├── AppShell.tsx          header + layout + footer
│   ├── SetupWizard.tsx       first-run 4-step guided setup
│   ├── CostSavings.tsx       animated savings counter
│   ├── ModelManager.tsx      install/switch/delete models
│   └── PrivacyDashboard.tsx  streak + data flow + audit log
└── views/        Lit views that host the React islands

src/gateway/      Express HTTP server + all /api/* routes
scripts/          Live integration check scripts (check-all.ts)
install.sh        One-command installer
```

## Data flow

User request → task-router (local vs cloud decision)
→ Ollama local model (default)
→ cost-tracker records inference + calculates savings
→ privacy-tracker records destination + updates streak

## Key design decisions

- Cloud is always opt-in. Local is always default.
- All persistent data lives in ~/.prowl/
- React widgets mount as Web Components inside a Lit shell
  (allows incremental React adoption without rewriting the full UI)
- HuggingFace bridge auto-selects GGUF quantization based on
  available RAM, then registers the model with Ollama via Modelfile
