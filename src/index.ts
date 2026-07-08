#!/usr/bin/env node
/**
 * ThumbAPI MCP Server (stdio).
 *
 * Wraps the public ThumbAPI REST endpoint `POST /v1/generate` as a single
 * MCP tool `generate_thumbnail` so AI agents (Claude Desktop, Cursor,
 * Windsurf, Cline, Continue) can generate thumbnails / OG images from
 * a title.
 *
 * Auth: reads `THUMBAPI_API_KEY` from the environment and forwards it as
 * the `x-api-key` header — the same mechanism the REST API expects.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const BASE_URL = (process.env.THUMBAPI_BASE_URL || "https://api.thumbapi.dev").replace(/\/+$/, "");
const API_KEY = process.env.THUMBAPI_API_KEY;

const FORMATS = ["youtube", "instagram", "x", "blogpost", "linkedin"] as const;

const GenerateInput = z.object({
  title: z
    .string()
    .min(1, "title must not be empty")
    .max(200, "title must be 200 characters or less"),
  format: z.enum(FORMATS),
  model: z.enum(["sd", "hd"]).optional(),
  outputFormat: z.enum(["webp", "png"]).optional(),
  category: z.string().optional(),
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
      description:
        "Optional content category hint that biases visual style (e.g. `tech`, `finance`, `gaming`, `cooking`). Leave empty to let the API auto-detect from the title.",
    },
  },
  required: ["title", "format"],
  additionalProperties: false,
} as const;

const TOOL_DESCRIPTION = `Generate a thumbnail / social share image from a title using the ThumbAPI service.

Use this when the user wants to create a YouTube thumbnail, Instagram post image, X/Twitter card, LinkedIn share image, or blog post hero image from a headline or title.

Returns the generated image inline (viewable by the model) plus metadata (format, outputFormat, generationId).

Requires the THUMBAPI_API_KEY environment variable. Get a key at https://thumbapi.dev.`;

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

async function callGenerate(input: GenerateInputT) {
  const url = `${BASE_URL}/v1/generate`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY!,
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "generate_thumbnail") {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }

  if (!API_KEY) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "THUMBAPI_API_KEY environment variable is not set. Add it to your MCP client config (see README) — get a key at https://thumbapi.dev.",
        },
      ],
    };
  }

  const parsed = GenerateInput.safeParse(req.params.arguments ?? {});
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
    const result = await callGenerate(parsed.data);
    const { mimeType, base64 } = splitDataUrl(result.image);

    return {
      content: [
        {
          type: "text",
          text: `Generated ${result.format} thumbnail (${result.outputFormat})${result.generationId ? ` — generationId: ${result.generationId}` : ""}.`,
        },
        {
          type: "image",
          data: base64,
          mimeType,
        },
      ],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: err?.message || String(err) }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't corrupt the stdio JSON-RPC channel.
  console.error(
    `[thumbapi-mcp-server] connected via stdio (base=${BASE_URL}, apiKey=${API_KEY ? "set" : "MISSING"})`,
  );
}

main().catch((err) => {
  console.error("[thumbapi-mcp-server] fatal:", err);
  process.exit(1);
});
