# @thumbapi/mcp-server

MCP server that exposes the [ThumbAPI](https://thumbapi.dev) thumbnail
generation endpoint as a Model Context Protocol tool. Point any MCP-compatible
AI agent at it and ask for a YouTube thumbnail, Instagram post, X/Twitter card,
LinkedIn share, or blog hero image from a title.

- Transport: **stdio** (local, no remote server, no OAuth)
- Runtime: **Node.js 18+**, installed via `npx`
- Tool exposed: `generate_thumbnail`

---

## Get your API key

1. Sign up at [thumbapi.dev](https://thumbapi.dev)
2. Open the dashboard and copy your API key (it starts with `yt_`)
3. Use it as the `THUMBAPI_API_KEY` env var in the configs below

For a smoke test without spending credits you can use the key `thumbapi_test`,
which returns a static placeholder image.

---

## Install & configure

Below are configs for the 5 most common MCP clients. Each uses the same
command / args / env — only the config file location and JSON wrapper shape
change per client.

### Claude Desktop

**Config file:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "thumbapi": {
      "command": "npx",
      "args": ["-y", "@thumbapi/mcp-server"],
      "env": {
        "THUMBAPI_API_KEY": "yt_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Cursor

**Config file:** `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "thumbapi": {
      "command": "npx",
      "args": ["-y", "@thumbapi/mcp-server"],
      "env": {
        "THUMBAPI_API_KEY": "yt_your_key_here"
      }
    }
  }
}
```

Reload Cursor's MCP servers from Settings → MCP.

### Windsurf

**Config file:** `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "thumbapi": {
      "command": "npx",
      "args": ["-y", "@thumbapi/mcp-server"],
      "env": {
        "THUMBAPI_API_KEY": "yt_your_key_here"
      }
    }
  }
}
```

Open Windsurf → Settings → Cascade → MCP Servers → Refresh.

### Cline (VS Code extension)

**Config file:**
- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "thumbapi": {
      "command": "npx",
      "args": ["-y", "@thumbapi/mcp-server"],
      "env": {
        "THUMBAPI_API_KEY": "yt_your_key_here"
      }
    }
  }
}
```

Open the Cline sidebar → MCP Servers → Restart.

### Continue.dev

**Config file:** `~/.continue/config.json`

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@thumbapi/mcp-server"],
          "env": {
            "THUMBAPI_API_KEY": "yt_your_key_here"
          }
        }
      }
    ]
  }
}
```

Reload Continue from the VS Code / JetBrains extension.

---

## Tool reference

### `generate_thumbnail`

Generates a thumbnail from a title.

| Param          | Type                                                     | Required | Notes |
| -------------- | -------------------------------------------------------- | -------- | ----- |
| `title`        | string (1–200 chars)                                     | yes      | The headline / video title. |
| `format`       | `youtube` \| `instagram` \| `x` \| `blogpost` \| `linkedin` | yes    | Target platform / aspect ratio. |
| `model`        | `sd` \| `hd`                                             | no       | Default `sd` (10 credits). `hd` needs Pro/Business (20 credits). |
| `outputFormat` | `webp` \| `png`                                          | no       | Default `webp`. |
| `category`     | string                                                   | no       | Content category hint (e.g. `tech`, `gaming`). |

Returns an MCP `image` content block plus a text summary with `generationId`.

---

## Environment variables

| Var                  | Required | Default                       | Notes |
| -------------------- | -------- | ----------------------------- | ----- |
| `THUMBAPI_API_KEY`   | yes      | —                             | Your `yt_...` key from thumbapi.dev. Use `thumbapi_test` for a placeholder smoke test. |
| `THUMBAPI_BASE_URL`  | no       | `https://api.thumbapi.dev`    | Override to point at a staging environment. |

---

## Local development

```bash
npm install
npm run build
THUMBAPI_API_KEY=thumbapi_test node dist/index.js
```

The server speaks JSON-RPC over stdio, so it's easiest to test by wiring it
into one of the clients above.

## License

MIT
