# MCP tools

Every successful call returns:

```json
{
  "structuredContent": {
    "schemaVersion": "codebone.v1",
    "data": {},
    "warnings": [],
    "truncated": false,
    "tokenEstimate": 123,
    "tokenEstimator": "char-div-4"
  },
  "content": [{ "type": "text", "text": "Human-readable rendering" }],
  "isError": false
}
```

Fatal errors return `isError: true` and `structuredContent.error` with a stable code such as `INVALID_INPUT`, `PATH_OUTSIDE_ROOT`, `SYMBOL_NOT_FOUND`, or `UNKNOWN_TOOL`.

## codebone_map

Purpose: compact repository overview.

Input schema:

```json
{ "path": "string", "budget": "integer", "limit": "integer", "offset": "integer" }
```

Example call:

```json
{ "path": ".", "limit": 20, "offset": 0 }
```

Example response:

```json
{ "schemaVersion": "codebone.v1", "languages": { "typescript": 20 }, "limit": 20, "offset": 0, "total": 4, "hasMore": false }
```

Use when an agent needs orientation. Do not use for exact function bodies; use `codebone_read`.

## codebone_skeleton

Purpose: structural symbols for a file or directory.

Input schema:

```json
{ "path": "string", "budget": "integer", "mode": "string", "signatures": "boolean", "maxFiles": "integer" }
```

Example call:

```json
{ "path": "src/index.ts", "signatures": true }
```

Example response:

```json
{ "schemaVersion": "codebone.v1", "file": "src/index.ts", "symbols": [], "tokenEstimator": "char-div-4" }
```

Use before opening files. Do not use when the agent already has a `symbolId`; use `codebone_read`.

## codebone_symbols

Purpose: find definitions and references.

Input schema:

```json
{ "query": "string", "path": "string", "kind": "string", "exact": "boolean", "fuzzy": "boolean", "limit": "integer", "offset": "integer" }
```

Example call:

```json
{ "query": "createInvoice", "path": ".", "kind": "all", "limit": 20 }
```

Example response:

```json
{ "schemaVersion": "codebone.v1", "query": "createInvoice", "matches": [], "total": 0, "hasMore": false }
```

Use to locate symbols. Do not use for broad task context; use `codebone_context`.

## codebone_read

Purpose: read exact symbol body, line range, or small file.

Input schema:

```json
{ "path": "string", "symbolId": "string", "symbol": "string", "lines": "string", "context": "integer", "maxBytes": "integer" }
```

Example call:

```json
{ "path": "src/billing.ts", "symbol": "createInvoice" }
```

Example response:

```json
{ "schemaVersion": "codebone.v1", "file": "src/billing.ts", "content": "1 | export function ..." }
```

Use after `map`, `skeleton`, or `symbols`. Do not use as first step on large repos.

## codebone_context

Purpose: task-focused context pack.

Input schema:

```json
{ "goal": "string", "goals": "array", "symbols": "array", "path": "string", "budget": "integer", "mode": "string" }
```

Example call:

```json
{ "goal": "billing invoice", "symbols": ["createInvoice"], "budget": 8000 }
```

Example response:

```json
{
  "schemaVersion": "codebone.v1",
  "goal": "billing invoice",
  "files": [],
  "suggestedNextReads": []
}
```

Use when planning a task. Do not use for impact checks immediately before editing; use `codebone_impact`.

## codebone_impact

Purpose: likely affected files, references, imports, relationships, and tests.

Input schema:

```json
{ "path": "string", "symbol": "string", "symbolId": "string", "lines": "string", "budget": "integer" }
```

Example call:

```json
{ "path": "src/billing.ts", "symbol": "createInvoice", "budget": 6000 }
```

Example response:

```json
{
  "schemaVersion": "codebone.v1",
  "target": { "path": "src/billing.ts" },
  "importedBy": [],
  "references": [],
  "likelyTests": [],
  "related": []
}
```

Use before editing. Do not use for reading a target body; use `codebone_read`.

## codebone_index

Purpose: optional local symbol index for repeated lookups.

Input schema:

```json
{ "path": "string", "clear": "boolean" }
```

Example call:

```json
{ "path": ".", "clear": false }
```

Use when repeated `symbols` calls need speed. Do not use in strict no-write sessions because it writes `.codebone/index.v1`.

## codebone_batch

Purpose: execute multiple codebone operations in order.

Input schema:

```json
{ "operations": [{ "op": "skeleton", "path": "src/index.ts" }] }
```

Example response:

```json
{ "schemaVersion": "codebone.v1", "results": [{ "success": true, "op": "skeleton" }] }
```

Use to reduce MCP round-trips. Do not use to bypass budgets; `batchBudget` is enforced.

## codebone_doctor

Purpose: diagnostics for parser coverage, config, cache, limits, skipped files, parse errors, and tests.

Input schema:

```json
{}
```

Example response:

```json
{ "schemaVersion": "codebone.v1", "status": "OK", "configSource": "defaults" }
```

Use when setup or output quality looks wrong. Do not use for source inspection.
