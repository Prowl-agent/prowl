# Contributing to Prowl

## Setup

```bash
git clone https://github.com/prowl-agent/prowl
cd prowl
pnpm install
pnpm build
```

## Running Tests

```bash
# Unit + integration tests
pnpm test

# React component tests
pnpm vitest run --config ui/vitest.react.config.ts

# Live integration (requires Ollama running)
npx tsx scripts/check-all.ts
```

## Guidelines

- One feature per PR
- Every new module needs a test file
- pnpm build must pass
- npx tsx scripts/check-all.ts must pass
- TypeScript strict mode — no `any`

## Commit style

feat: short description
fix: short description  
chore: short description
