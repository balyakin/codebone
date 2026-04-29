# codebone

Agent-native CLI and MCP server for compact, read-only code context.

## Quick Start

```bash
npm install
npm run build
npx codebone doctor
npx codebone skeleton src --format json
npx codebone mcp --root .
```

## MCP Configuration

Claude Code `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "codebone": {
      "command": "npx",
      "args": ["-y", "codebone", "mcp", "--root", "."]
    }
  }
}
```

Cline settings:

```json
{
  "cline.mcpServers": {
    "codebone": {
      "command": "npx",
      "args": ["-y", "codebone", "mcp", "--root", "."]
    }
  }
}
```

OpenCode example:

```json
{
  "mcp": {
    "codebone": {
      "command": "npx",
      "args": ["-y", "codebone", "mcp", "--root", "."]
    }
  }
}
```

## Commands

- `codebone map [directory]`
- `codebone skeleton <path>`
- `codebone symbols <path> --query <name>`
- `codebone read <path> --symbol-id <id>`
- `codebone read <path> --symbol <name>`
- `codebone read <path> --lines 10:30`
- `codebone context --goal "task"`
- `codebone index [directory]`
- `codebone batch`
- `codebone doctor`
- `codebone mcp`

The current implementation is read-only and zero external CLI. It supports TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, C#, Ruby, PHP, Swift, Kotlin, and Lua with syntax-aware extraction rules.

## Language Tiers

- Gold: TypeScript, Python, Go, Rust tree-sitter WASM parser smoke coverage.
- Fallback: JavaScript, Java, C/C++, C#, Ruby, PHP, Swift, Kotlin, Lua syntax-rule extraction.
- References are AST-first where queries expose `@reference`, with text fallback otherwise.

## Release Check

```bash
npm run release:check
```

## MCP Inspector

After `npm run build`, run:

```bash
npm run mcp:inspector
```
