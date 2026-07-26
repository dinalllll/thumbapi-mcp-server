# @thumbapi/mcp-server

MCP server that exposes the [ThumbAPI](https://thumbapi.dev) thumbnail
generation endpoint as a Model Context Protocol tool. Point any MCP-compatible
AI agent at it and ask for a YouTube thumbnail, Instagram post, X/Twitter card,
LinkedIn share, or blog hero image from a title.

- Transport: **stdio** (local, no remote server)
- Runtime: **Node.js 18+**, installed via `npx`
- Tools exposed: `generate_thumbnail`, `login`, `logout`

---

## Sign in

The first time you use the MCP, ask your client (Claude Desktop, Cursor,
Claude Code, Windsurf, Cline, Continue) to **"log in to thumbapi"** — that
triggers the `login` tool. It:

1. Spins up a one-shot local callback server on a random loopback port.
2. Opens your browser to `app.thumbapi.dev/mcp-login`.
3. Waits for you to click **Authorize** on the page (log in first if needed).
4. Writes your API key to `~/.thumbapi/config.json` (mode `0600`, dir `0700`).

Every subsequent `generate_thumbnail` call reads from that file. No copy-paste.

To sign out locally, ask your client to **"log out of thumbapi"** — that runs
the `logout` tool, which deletes `~/.thumbapi/config.json`. The key on the
ThumbAPI dashboard is untouched (rotate it in the dashboard if you also want
to invalidate the key server-side).

---

## Install & configure

Below are configs for the 5 most common MCP clients. Each uses the same
`command` and `args` — only the config file location and JSON wrapper shape
change per client. No API key goes into the config; the `login` tool handles
that on first use.

### Claude Desktop

**Config file:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "thumbapi": {
      "command": "npx",
      "args": ["-y", "@thumbapi/mcp-server"]
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
      "args": ["-y", "@thumbapi/mcp-server"]
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
      "args": ["-y", "@thumbapi/mcp-server"]
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
      "args": ["-y", "@thumbapi/mcp-server"]
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
          "args": ["-y", "@thumbapi/mcp-server"]
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
| `category`     | string                                                   | no       | Content category hint (e.g. `tech-saas`, `gaming`). See the [API docs](https://thumbapi.dev/docs/endpoints/generate#categories) for the full list. |

Returns an MCP `image` content block plus a text summary that includes:

- `generationId` — stable ID for the generation (useful for logs and audits).
- `imageUrl` — public URL on ThumbAPI's CDN. Use this to download or embed the
  image without decoding base64. The URL is served from Cloudflare R2 and is
  returned on every successful generation (v1.1.0+).

### `login`

Signs the MCP server in to ThumbAPI. Starts a local
callback server on a random loopback port, opens your browser to
`https://app.thumbapi.dev/mcp-login?callback=…&state=…`, and waits for you to
click **Authorize** on the page. The returned API key is written to
`~/.thumbapi/config.json` (`mode 0600`, directory `0700`).

- Takes no arguments.
- Blocks up to ~30 seconds per invocation waiting for the browser callback.
  If you haven't consented yet, the tool returns "Waiting for browser
  approval…" — just call `login` again to keep polling. The underlying local
  server stays alive across calls for up to 15 minutes.
- Idempotent: calling `login` again while a flow is in progress reuses the
  same URL / port.
- Only accepts callback traffic bound to `127.0.0.1` and requires the CSRF
  `state` param to match — no other machine on your LAN can hit the callback.

### `logout`

Deletes `~/.thumbapi/config.json`. Takes no arguments. Does **not** revoke the
key server-side — rotate it in the [dashboard](https://app.thumbapi.dev) if
you want to invalidate the key everywhere.

---

## License

MIT
