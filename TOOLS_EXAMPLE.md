# Tools Example

This project exposes MCP tools from `src/mcp-server.ts`. The examples below are
representative and intentionally shortened. Numeric counts depend on the scanned
repository state.

## Common Tool Result

Every successful `tools/call` is wrapped in the same MCP result shape:

```json
{
  "structuredContent": {
    "schemaVersion": "codebone.v1",
    "data": {
      "schemaVersion": "codebone.v1"
    },
    "warnings": [],
    "truncated": false,
    "tokenEstimate": 123
  },
  "content": [
    {
      "type": "text",
      "text": "Human-readable rendering of the same payload"
    }
  ],
  "isError": false
}
```

`structuredContent.data` is the tool-specific payload. Most payloads also carry
their own `schemaVersion`, `warnings`, `truncated`, and `tokenEstimate` fields,
so those values can appear both inside `data` and in the outer structured
wrapper.

Errors keep the MCP shape but set `isError` to `true`:

```json
{
  "structuredContent": {
    "schemaVersion": "codebone.v1",
    "error": "Unknown tool: codebone_unknown"
  },
  "content": [
    {
      "type": "text",
      "text": "Unknown tool: codebone_unknown"
    }
  ],
  "isError": true
}
```

## codebone_map

Returns a compact project map: languages, indexed file counts, entrypoints,
top directories, import/export graph summary, and suggested next reads.

Example call:

```json
{
  "path": ".",
  "budget": 1200
}
```

Example `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "languages": {
    "typescript": 50,
    "javascript": 2,
    "python": 1
  },
  "files": {
    "indexed": 55,
    "ignored": 3688,
    "unsupported": 1664
  },
  "entrypoints": [
    "src/index.ts",
    "src/mcp-server.ts"
  ],
  "topDirectories": [
    {
      "path": "src/core",
      "files": 15,
      "symbols": 144
    }
  ],
  "graph": {
    "imports": 236,
    "resolvedImports": 1,
    "exports": 92,
    "hotFiles": [
      {
        "path": "src/mcp-server.ts",
        "imports": 18,
        "importedBy": 0
      }
    ]
  },
  "suggestedReads": [
    {
      "command": "skeleton",
      "path": "src/index.ts"
    },
    {
      "command": "context",
      "goal": "understand project structure",
      "budget": 48000
    }
  ],
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 465
}
```

## codebone_skeleton

Returns the structural skeleton of a file or directory. File responses contain
one `SkeletonData` object. Directory responses contain `skeletons`, one item per
file included in the directory scan.

Example file call:

```json
{
  "path": "src/mcp-server.ts",
  "budget": 12000,
  "includeImports": true
}
```

Example file `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "file": "src/mcp-server.ts",
  "language": "typescript",
  "totalLines": 266,
  "symbols": [
    {
      "symbolId": "src/mcp-server.ts#function:createSdkServer@44:7-63:1:37085c2a",
      "contentHash": "37085c2a",
      "kind": "function",
      "name": "createSdkServer",
      "qualifiedName": "createSdkServer",
      "signature": "function createSdkServer(projectRoot: string): Server",
      "exported": true,
      "confidence": "high",
      "parameters": [
        {
          "name": "projectRoot",
          "type": "string"
        }
      ],
      "returnType": "Server",
      "visibility": "public",
      "language": "typescript",
      "file": "src/mcp-server.ts",
      "startLine": 44,
      "startColumn": 7,
      "endLine": 63,
      "endColumn": 1,
      "startByte": 2124,
      "endByte": 3292
    }
  ],
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 911
}
```

Example directory call:

```json
{
  "path": "src/core",
  "mode": "summary",
  "maxFiles": 10,
  "budget": 4000
}
```

Example directory `structuredContent.data`:

```json
{
  "files": 2,
  "skeletons": [
    {
      "schemaVersion": "codebone.v1",
      "file": "src/core/map.ts",
      "language": "typescript",
      "totalLines": 69,
      "symbols": []
    }
  ],
  "mode": "summary",
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 321
}
```

Common options include `publicOnly`, `symbolsOnly`, `includeImports`,
`includePrivate`, `includeRoutes`, `changedOnly`, `maxFiles`, and `budget`.
Supported modes include `full`, `summary`, and `public_api`. Detail-oriented
mode values such as `rpc_api`, `lifecycle`, `app_dependencies`, and
`public_methods` are currently accepted and applied as detail filters.

## codebone_symbols

Searches definitions, references, exports, or imports by symbol name or
qualified name.

Example call:

```json
{
  "query": "createSdkServer",
  "path": ".",
  "kind": "definition",
  "limit": 5
}
```

Example `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "query": "createSdkServer",
  "matches": [
    {
      "symbolId": "src/mcp-server.ts#function:createSdkServer@44:7-63:1:37085c2a",
      "kind": "definition",
      "exported": true,
      "file": "src/mcp-server.ts",
      "line": 44,
      "column": 7,
      "symbolKind": "function",
      "signature": "function createSdkServer(projectRoot: string): Server",
      "context": "function createSdkServer(projectRoot: string): Server",
      "confidence": "high"
    }
  ],
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 33
}
```

For reference matches, each `matches` item has `kind: "reference"` and may also
include `source: "ast"` or `source: "text"`.

## codebone_read

Reads a file, a line range, or a specific symbol body. Prefer `symbolId` from
`codebone_skeleton` or `codebone_symbols` when available.

Example line-range call:

```json
{
  "path": "src/mcp-server.ts",
  "lines": "103:120",
  "context": 0,
  "maxBytes": 65536
}
```

Example `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "file": "src/mcp-server.ts",
  "label": "src/mcp-server.ts:103..120",
  "startLine": 103,
  "endLine": 120,
  "content": " 103 | async function callTool(...)",
  "text": " 103 | async function callTool(...)",
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 260
}
```

Example symbol call:

```json
{
  "path": "src/mcp-server.ts",
  "symbolId": "src/mcp-server.ts#function:createSdkServer@44:7-63:1:37085c2a",
  "context": 2
}
```

When reading by symbol, the response also includes the recovered `symbolId` and
uses a label like `src/mcp-server.ts:44..63 - function createSdkServer`.

## codebone_context

Builds a ranked context pack for a task goal. Full mode returns selected
skeletons and symbol bodies. Structural modes return compact summaries plus
suggested next reads.

Example call:

```json
{
  "goal": "understand MCP tools",
  "path": ".",
  "mode": "overview",
  "budget": 8000,
  "includeTests": true
}
```

Example `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "goal": "understand MCP tools",
  "mode": "overview",
  "budget": 8000,
  "usedTokens": 1200,
  "items": [
    {
      "type": "overview_summary",
      "path": ".",
      "score": 1,
      "reason": "compact overview summary",
      "content": "Architecture / project summary text"
    }
  ],
  "omitted": [],
  "nextReads": [
    {
      "command": "skeleton",
      "path": "src/mcp-server.ts",
      "symbolId": "src/mcp-server.ts#function:createSdkServer@44:7-63:1:37085c2a"
    }
  ],
  "architecture": {
    "files": 55,
    "entrypoints": [],
    "layers": [],
    "exports": [],
    "hotFiles": []
  },
  "testRelations": [],
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 1200
}
```

Supported modes are `full`, `overview`, `edit_prep`, `composition`,
`architecture`, and `test_impact`.

## codebone_batch

Runs multiple operations in one MCP call. Supported operation names are `map`,
`skeleton`, `symbols`, `read`, `context`, and `index`. Each operation may use
`op`, `tool`, or `name`; `codebone_` prefixes are normalized away.

Example call:

```json
{
  "operations": [
    {
      "op": "map",
      "path": ".",
      "budget": 1200
    },
    {
      "tool": "codebone_symbols",
      "query": "createSdkServer",
      "kind": "definition",
      "limit": 5
    }
  ]
}
```

Example `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "results": [
    {
      "schemaVersion": "codebone.v1",
      "op": "map",
      "path": ".",
      "success": true,
      "data": {
        "schemaVersion": "codebone.v1",
        "languages": {
          "typescript": 50
        }
      },
      "elapsedMs": 25
    },
    {
      "schemaVersion": "codebone.v1",
      "op": "symbols",
      "success": true,
      "data": {
        "schemaVersion": "codebone.v1",
        "query": "createSdkServer",
        "matches": []
      },
      "elapsedMs": 10
    }
  ],
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 100,
  "elapsedMs": 35
}
```

Failed operations stay inside `results` with `success: false` and an `error`
field.

## codebone_index

Builds or updates the local symbol index under `.codebone/index.v1`.

Example call:

```json
{
  "path": ".",
  "clear": false
}
```

Example `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "rootHash": "0f842a64abcd",
  "createdAt": "2026-05-02T12:00:00.000Z",
  "files": 55,
  "symbols": 240,
  "languages": {
    "typescript": 50,
    "javascript": 2
  },
  "fileMeta": [
    {
      "relativePath": "src/mcp-server.ts",
      "size": 18454,
      "mtimeMs": 1777723200000,
      "hash": "3b7d1d4f0f0a1b2c3d4e5f60718293a4b5c6d7e8",
      "shard": "5f2dbb5a0d0f5a86f1a6f6d4a2a0a2b5b4f3c2d1.json"
    }
  ],
  "incremental": {
    "reused": 50,
    "updated": 5,
    "deleted": 0
  },
  "dictionaries": {
    "byName": "dictionaries/by-name.json",
    "byPath": "dictionaries/by-path.json",
    "byQualifiedName": "dictionaries/by-qualified-name.json",
    "imports": "dictionaries/imports.json",
    "exports": "dictionaries/exports.json",
    "trigrams": "dictionaries/trigrams.json"
  },
  "indexPath": ".codebone/index.v1",
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 100
}
```

## codebone_doctor

Checks runtime health: package version, Node.js version, grammar availability,
index writability, stdio guard, and network policy.

Example call:

```json
{}
```

Example `structuredContent.data`:

```json
{
  "schemaVersion": "codebone.v1",
  "version": "0.1.2",
  "node": "v20.17.0",
  "grammars": {
    "mode": "tree-sitter-wasm+syntax-fallback",
    "loaded": 4,
    "fallback": 10,
    "missing": 0,
    "gold": [
      "typescript",
      "python",
      "go",
      "rust"
    ],
    "missingLanguages": []
  },
  "indexDirectory": "ok",
  "mcpStdioGuard": "ok",
  "networkAccess": "disabled",
  "warnings": [],
  "truncated": false,
  "tokenEstimate": 60
}
```

