# MCP clients

Use stdio transport and pass an absolute `--root`. The generic fallback command is:

```bash
codebone mcp --root /absolute/path/to/repo
```

## Claude Code

Checked against Anthropic Claude Code MCP docs on 2026-05-17.

```bash
claude mcp add codebone -- codebone mcp --root /absolute/path/to/repo
```

Project `.mcp.json`:

```json
{
  "mcpServers": {
    "codebone": {
      "command": "codebone",
      "args": ["mcp", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

## Codex CLI

Checked against OpenAI Codex CLI MCP configuration docs on 2026-05-17.

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.codebone]
command = "codebone"
args = ["mcp", "--root", "/absolute/path/to/repo"]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 120
```

## Cline

Checked against Cline MCP configuration docs on 2026-05-17.

```bash
cline mcp add codebone -- codebone mcp --root /absolute/path/to/repo
```

Or edit `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "codebone": {
      "command": "codebone",
      "args": ["mcp", "--root", "/absolute/path/to/repo"],
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

## OpenCode

Checked against OpenCode MCP server docs on 2026-05-17.

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codebone": {
      "type": "local",
      "command": ["codebone", "mcp", "--root", "/absolute/path/to/repo"],
      "enabled": true
    }
  }
}
```

## Verify

After starting the client, ask it to list MCP tools or run:

```text
Use codebone first. Start with codebone_map, then use codebone_symbols and codebone_read before opening full files. Keep context compact.
```
