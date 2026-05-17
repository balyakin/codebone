# Configuration

Config precedence:

1. CLI flags
2. `.codebonerc.json`
3. `package.json#codebone`
4. defaults

## `.codebonerc.json`

```json
{
  "defaultBudget": 8000,
  "maxBudget": 50000,
  "batchBudget": 50000,
  "maxFiles": 10000,
  "maxFileBytes": 1048576,
  "timeoutMs": 30000,
  "cache": {
    "enabled": true,
    "maxFiles": 5000,
    "maxBytes": 67108864
  },
  "ignore": ["dist/**", "*.generated.*"],
  "testPatterns": ["**/*.test.*", "**/*.spec.*", "tests/**"],
  "entrypoints": ["src/index.ts"]
}
```

## `package.json#codebone`

```json
{
  "codebone": {
    "defaultBudget": 8000,
    "ignore": ["fixtures/**"],
    "testPatterns": ["tests/**"]
  }
}
```

## Ignore behavior

codebone always excludes common heavy/generated paths such as `.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`, lockfiles, source maps, minified files, generated files, and binary files. It also reads root-level `.gitignore` and `.codeboneignore`.

Example `.codeboneignore`:

```gitignore
fixtures/**
*.generated.*
```

CLI one-shot ignore:

```bash
codebone context --goal "billing" --ignore "src/generated/**"
```

## Resource limits

```bash
codebone map . --max-files 10000 --max-file-bytes 1048576 --timeout-ms 30000
```

Pagination:

```bash
codebone map . --limit 100 --offset 0
codebone symbols src --query createInvoice --limit 20 --offset 0
```

## Cache

MCP uses a bounded in-memory cache by default for runtime data. Disable it for diagnostics:

```bash
codebone mcp --root /absolute/path/to/repo --no-cache
```

No persistent runtime cache is written. The explicit `codebone index` command writes `.codebone/index.v1`.

## Budgets and tokens

`context` defaults to `defaultBudget`. `impact` defaults to `6000`, clamped by `maxBudget`. `batchBudget` caps the sum of budget-bearing batch operations and cannot exceed `250000`.

Token estimates use:

```text
estimatedTokens = ceil(charCount / 4)
```

The estimator is deterministic and reported as `tokenEstimator: "char-div-4"`. It is an approximation, not a model tokenizer.
