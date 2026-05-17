# Quickstart

## Install

From npm:

```bash
npm install -g codebone
```

Local development:

```bash
git clone https://github.com/balyakin/codebone
cd codebone
npm install
npm run build
node dist/index.js doctor
```

## First checks

Run these inside any repository:

```bash
codebone doctor --root /absolute/path/to/repo
codebone map . --root /absolute/path/to/repo --format json --limit 20
codebone skeleton src/index.ts --root /absolute/path/to/repo
codebone context --root /absolute/path/to/repo --goal "understand MCP server" --budget 8000
```

Expected output:

- `doctor` reports parser/config/cache/limit diagnostics.
- `map` returns languages, entrypoints, top directories, pagination metadata, and suggested reads.
- `skeleton` returns symbols without full function bodies.
- `context` returns a budgeted context pack with `suggestedNextReads`.

For impact planning:

```bash
codebone impact src/index.ts --root /absolute/path/to/repo --format md
```
