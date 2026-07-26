#!/usr/bin/env node
/**
 * ThumbAPI MCP Server (stdio).
 *
 * Wraps the public ThumbAPI REST endpoint `POST /v1/generate` as MCP tools
 * so AI agents (Claude Desktop, Cursor, Windsurf, Cline, Continue) can
 * generate thumbnails / OG images from a title.
 *
 * Auth:
 *   1. `THUMBAPI_API_KEY` environment variable (backwards-compatible).
 *   2. `~/.thumbapi/config.json` written by the `login` tool below.
 *   3. If neither is present, tools return a helpful "run login" error.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";

const BASE_URL = (process.env.THUMBAPI_BASE_URL || "https://api.thumbapi.dev").replace(/\/+$/, "");
const APP_URL = (process.env.THUMBAPI_APP_URL || "https://app.thumbapi.dev").replace(/\/+$/, "");
const CONFIG_DIR = path.join(os.homedir(), ".thumbapi");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
// A single `login` tool invocation blocks up to this long for the browser
// callback before returning "still waiting" so the MCP client's per-call
// timeout (Claude Code / Desktop / Cursor / Windsurf all differ) never
// fires. The underlying local server keeps running across invocations up
// to LOGIN_TOTAL_TTL_MS so the user can just say "login" again.
const LOGIN_POLL_WAIT_MS = 30_000;
const LOGIN_TOTAL_TTL_MS = 15 * 60 * 1000;

function readConfig(): { apiKey?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeConfig(config: { apiKey: string }): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist with different mode — that's fine.
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function deleteConfig(): boolean {
  try {
    fs.unlinkSync(CONFIG_FILE);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

/** Resolve the current API key at request time (not module load). */
function resolveApiKey(): string | null {
  if (process.env.THUMBAPI_API_KEY) return process.env.THUMBAPI_API_KEY;
  const cfg = readConfig();
  if (cfg && typeof cfg.apiKey === "string" && cfg.apiKey) return cfg.apiKey;
  return null;
}

/** Cross-platform browser open (no external deps). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort — the login tool always prints the URL in its response so
    // the user can still open it manually.
  }
}

type PendingLogin = {
  server: http.Server;
  port: number;
  state: string;
  url: string;
  createdAt: number;
  keyPromise: Promise<string>;
  keyResolve: (key: string) => void;
  timeout: NodeJS.Timeout;
};

let pendingLogin: PendingLogin | null = null;

function closePendingLogin(): void {
  if (!pendingLogin) return;
  try { pendingLogin.server.close(); } catch { /* ignore */ }
  try { clearTimeout(pendingLogin.timeout); } catch { /* ignore */ }
  pendingLogin = null;
}

/**
 * HTML served on GET /callback. The browser lands here after the /mcp-login
 * page fragment-redirects. Server-side we never see the fragment (browsers
 * strip it before the HTTP request) so JS reads window.location.hash and
 * posts the api_key back to /submit on the same origin.
 */
const CALLBACK_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>ThumbAPI Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: #111; background: #fafafa; margin: 0;
         min-height: 100vh; display: grid; place-items: center; }
  .card { background: #fff; padding: 2rem 2.5rem; border-radius: 12px;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 420px; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
  p { margin: .5rem 0; color: #555; }
  .ok { color: #0a7f2e; }
  .err { color: #b3261e; }
</style>
</head><body>
<div class="card">
  <h1 id="title">Finalizing sign-in…</h1>
  <p id="msg">Contacting your local MCP client.</p>
</div>
<script>
(function () {
  var params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var apiKey = params.get("api_key");
  var state = params.get("state");
  if (!apiKey) {
    document.getElementById("title").textContent = "Sign-in failed";
    document.getElementById("title").className = "err";
    document.getElementById("msg").textContent = "No API key in the callback URL.";
    return;
  }
  fetch("/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, state: state }),
  })
    .then(function (r) {
      if (r.ok) {
        document.getElementById("title").textContent = "✓ Signed in";
        document.getElementById("title").className = "ok";
        document.getElementById("msg").textContent = "You can close this tab.";
      } else {
        return r.text().then(function (t) {
          document.getElementById("title").textContent = "Sign-in failed";
          document.getElementById("title").className = "err";
          document.getElementById("msg").textContent = t || ("HTTP " + r.status);
        });
      }
    })
    .catch(function (err) {
      document.getElementById("title").textContent = "Sign-in failed";
      document.getElementById("title").className = "err";
      document.getElementById("msg").textContent = "Could not reach the MCP client: " + err.message;
    });
  // Strip fragment from address bar so the key isn't visible on-screen.
  if (window.history && window.history.replaceState) {
    window.history.replaceState({}, "", window.location.pathname);
  }
})();
</script>
</body></html>`;

/** Start a fresh callback server and record it as the module-level pendingLogin. */
async function startPendingLogin(): Promise<PendingLogin> {
  const state = crypto.randomBytes(16).toString("hex");
  let keyResolve!: (key: string) => void;
  const keyPromise = new Promise<string>((r) => { keyResolve = r; });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1`);
    if (req.method === "GET" && url.pathname === "/callback") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(CALLBACK_HTML);
      return;
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); if (body.length > 4096) req.destroy(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed?.state !== "string" || parsed.state !== state) {
            res.writeHead(403, { "Content-Type": "text/plain" }); res.end("state mismatch"); return;
          }
          if (typeof parsed?.api_key !== "string" || !parsed.api_key) {
            res.writeHead(400, { "Content-Type": "text/plain" }); res.end("missing api_key"); return;
          }
          keyResolve(parsed.api_key);
          res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok");
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" }); res.end("invalid json");
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found");
  });

  return new Promise<PendingLogin>((resolve, reject) => {
    server.once("error", reject);
    // Bind to loopback only — never expose the callback to other machines on the LAN.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to bind local callback server"));
        return;
      }
      const port = addr.port;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const loginUrl =
        `${APP_URL}/mcp-login?callback=${encodeURIComponent(callbackUrl)}&state=${state}`;
      const timeout = setTimeout(() => closePendingLogin(), LOGIN_TOTAL_TTL_MS);
      pendingLogin = {
        server, port, state, url: loginUrl,
        createdAt: Date.now(),
        keyPromise, keyResolve, timeout,
      };
      resolve(pendingLogin);
    });
  });
}

const FORMATS = ["youtube", "instagram", "x", "blogpost", "linkedin"] as const;

// Full category list accepted by the ThumbAPI /v1/generate endpoint. Kept
// in sync with the backend validator (src/lib/prompt-builder CATEGORY_BRIEFS)
// — any drift will surface as a 400 "category must be one of" from the API.
const CATEGORIES = [
  "auto",
  "tech-saas",
  "business-finance",
  "education-tutorial",
  "fitness-wellness",
  "medical-healthcare",
  "lifestyle-vlog",
  "food-cooking",
  "travel",
  "gaming",
  "entertainment-comedy",
  "news-commentary",
  "creative-design",
] as const;

const GenerateInput = z.object({
  title: z
    .string()
    .min(1, "title must not be empty")
    .max(200, "title must be 200 characters or less"),
  format: z.enum(FORMATS),
  model: z.enum(["sd", "hd"]).optional(),
  outputFormat: z.enum(["webp", "png"]).optional(),
  category: z.enum(CATEGORIES).optional(),
});

type GenerateInputT = z.infer<typeof GenerateInput>;

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "The headline / video title / blog post title to render on the thumbnail. Required. Max 200 chars. Write the title exactly as it should appear.",
    },
    format: {
      type: "string",
      enum: [...FORMATS],
      description:
        "Target platform / aspect ratio. `youtube` = 1280x720 (16:9), `instagram` = 1080x1080 (1:1), `x` = 1600x900 (16:9, Twitter/X card), `blogpost` = photorealistic hero image (16:9), `linkedin` = 1200x627 (LinkedIn share).",
    },
    model: {
      type: "string",
      enum: ["sd", "hd"],
      description:
        "Generation model. `sd` (default) is faster and cheaper (10 credits). `hd` produces higher quality output but requires a Pro or Business plan (20 credits).",
    },
    outputFormat: {
      type: "string",
      enum: ["webp", "png"],
      description: "Image encoding of the returned file. Defaults to `webp`.",
    },
    category: {
      type: "string",
      enum: [...CATEGORIES],
      description:
        "Optional content category hint that biases visual style. Choose the closest match, or omit to let the API auto-detect from the title (equivalent to `auto`).",
    },
  },
  required: ["title", "format"],
  additionalProperties: false,
} as const;

const TOOL_DESCRIPTION = `Generate a thumbnail / social share image from a title using the ThumbAPI service.

Use this when the user wants to create a YouTube thumbnail, Instagram post image, X/Twitter card, LinkedIn share image, or blog post hero image from a headline or title.

Returns the generated image inline (viewable by the model) plus metadata: format, outputFormat, generationId, and imageUrl (a public URL on ThumbAPI's CDN — use this to download or embed the image without handling base64).

Requires an API key. Either set THUMBAPI_API_KEY in the environment or run the \`login\` tool once — that starts an OAuth-style browser flow and saves the key to ~/.thumbapi/config.json. Get a key at https://thumbapi.dev.`;

const LOGIN_TOOL_DESCRIPTION = `Sign the MCP server in to ThumbAPI. Opens a browser to app.thumbapi.dev/mcp-login, asks the user to consent, and saves the returned API key to ~/.thumbapi/config.json.

Call this tool when:
  - The user asks to log in / sign in / authenticate to ThumbAPI.
  - Another tool (generate_thumbnail) returns "no API key found".

The tool blocks up to ~30s per invocation waiting for the browser callback. If the user hasn't consented yet, it returns "still waiting" — just call login again to keep waiting. The underlying local callback server stays alive across calls for up to 15 minutes.`;

const LOGOUT_TOOL_DESCRIPTION = `Remove the saved ThumbAPI API key from ~/.thumbapi/config.json. Does not revoke the key on the server — that's a separate action from the dashboard.`;

function friendlyError(status: number, body: any): string {
  const apiMsg = (body && typeof body === "object" && body.error) ? body.error : null;
  const code = (body && typeof body === "object" && body.code) ? body.code : null;

  if (status === 401) {
    return `ThumbAPI rejected the API key (401 ${code || "UNAUTHORIZED"}). Check that THUMBAPI_API_KEY is set to a valid key from https://thumbapi.dev (keys start with \`yt_\`).`;
  }
  if (status === 403) {
    return `ThumbAPI returned 403 ${code || "FORBIDDEN"}: ${apiMsg || "your plan does not allow this request"}. Upgrade at https://thumbapi.dev to unlock this feature.`;
  }
  if (status === 429) {
    return `ThumbAPI rate limit / credit limit hit (429 ${code || "LIMIT"}): ${apiMsg || "too many requests or monthly credits exhausted"}. Wait a minute or upgrade your plan.`;
  }
  if (status >= 500) {
    return `ThumbAPI server error (${status}): ${apiMsg || "unknown error"}. This is on the ThumbAPI side — try again in a moment.`;
  }
  return `ThumbAPI returned ${status}${code ? ` ${code}` : ""}: ${apiMsg || "unknown error"}`;
}

async function callGenerate(input: GenerateInputT, apiKey: string) {
  const url = `${BASE_URL}/v1/generate`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(input),
    });
  } catch (err: any) {
    throw new Error(
      `Network error contacting ThumbAPI at ${url}: ${err?.message || String(err)}`,
    );
  }

  const raw = await response.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // Non-JSON response body; keep parsed=null and surface raw text in the error.
  }

  if (!response.ok) {
    throw new Error(friendlyError(response.status, parsed ?? raw));
  }

  if (!parsed || typeof parsed !== "object" || !parsed.image) {
    throw new Error("ThumbAPI returned a 2xx response but no image payload.");
  }

  return parsed as {
    image: string;
    format: string;
    outputFormat: string;
    generationId?: string;
    imageUrl?: string;
  };
}

function splitDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    // Fall back: assume it's already raw base64 with unknown mime.
    return { mimeType: "image/png", base64: dataUrl };
  }
  return { mimeType: match[1], base64: match[2] };
}

const server = new Server(
  {
    name: "thumbapi-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_thumbnail",
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_INPUT_SCHEMA,
    },
    {
      name: "login",
      description: LOGIN_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
    },
    {
      name: "logout",
      description: LOGOUT_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
    },
  ],
}));

async function handleLogin(): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  // Reuse an in-flight pending login across tool calls so `login` is
  // idempotent — the user can say "login" multiple times while the browser
  // tab is open and each call just polls the same server.
  if (!pendingLogin) {
    try {
      const p = await startPendingLogin();
      openBrowser(p.url);
    } catch (err: any) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Failed to start local callback server: ${err?.message || String(err)}`,
        }],
      };
    }
  }

  const currentUrl = pendingLogin!.url;

  const key = await Promise.race([
    pendingLogin!.keyPromise,
    new Promise<null>((r) => setTimeout(() => r(null), LOGIN_POLL_WAIT_MS)),
  ]);

  if (typeof key === "string" && key) {
    try {
      writeConfig({ apiKey: key });
    } catch (err: any) {
      closePendingLogin();
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Signed in, but failed to save config to ${CONFIG_FILE}: ${err?.message || String(err)}. Set THUMBAPI_API_KEY manually in the meantime.`,
        }],
      };
    }
    closePendingLogin();
    return {
      content: [{
        type: "text",
        text: `✓ Signed in to ThumbAPI. API key saved to ${CONFIG_FILE}. You can close the browser tab.`,
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: `Waiting for browser approval. If the browser didn't open, visit:\n\n${currentUrl}\n\nAfter you click Authorize, call this login tool again to finalize.`,
    }],
  };
}

async function handleLogout(): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  // Cancel any in-flight login flow so a subsequent login starts fresh.
  closePendingLogin();
  try {
    const removed = deleteConfig();
    return {
      content: [{
        type: "text",
        text: removed
          ? `✓ Signed out. Removed ${CONFIG_FILE}. THUMBAPI_API_KEY env var (if any) is untouched.`
          : `No local config to remove — ${CONFIG_FILE} did not exist. THUMBAPI_API_KEY env var (if any) is untouched.`,
      }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Failed to remove ${CONFIG_FILE}: ${err?.message || String(err)}` }],
    };
  }
}

async function handleGenerate(args: unknown): Promise<{
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    return {
      isError: true,
      content: [{
        type: "text",
        text:
          "No ThumbAPI API key found. Either set THUMBAPI_API_KEY in the MCP client config, or run the `login` tool to sign in via browser. Get a key at https://thumbapi.dev.",
      }],
    };
  }

  const parsed = GenerateInput.safeParse(args ?? {});
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
      .join("; ");
    return {
      isError: true,
      content: [{ type: "text", text: `Invalid arguments: ${msg}` }],
    };
  }

  try {
    const result = await callGenerate(parsed.data, apiKey);
    const { mimeType, base64 } = splitDataUrl(result.image);

    const summary = [
      `Generated ${result.format} thumbnail (${result.outputFormat})`,
      result.generationId ? `generationId: ${result.generationId}` : null,
      result.imageUrl ? `imageUrl: ${result.imageUrl}` : null,
    ]
      .filter(Boolean)
      .join(" — ");

    return {
      content: [
        { type: "text", text: `${summary}.` },
        { type: "image", data: base64, mimeType },
      ],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: err?.message || String(err) }],
    };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name === "generate_thumbnail") return handleGenerate(req.params.arguments);
  if (name === "login") return handleLogin();
  if (name === "logout") return handleLogout();
  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't corrupt the stdio JSON-RPC channel.
  const source =
    process.env.THUMBAPI_API_KEY ? "env"
      : readConfig()?.apiKey ? "config"
        : "MISSING (run the `login` tool)";
  console.error(
    `[thumbapi-mcp-server] connected via stdio (base=${BASE_URL}, apiKey=${source})`,
  );
}

main().catch((err) => {
  console.error("[thumbapi-mcp-server] fatal:", err);
  process.exit(1);
});
