#!/usr/bin/env node
// Minimal MCP stdio smoke test: spawns the built server, initializes,
// lists tools, calls generate_thumbnail with the built-in test key, and
// verifies the response has an image content block.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "..", "dist", "index.js");

const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    THUMBAPI_API_KEY: process.env.THUMBAPI_API_KEY || "thumbapi_test",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[smoke] non-JSON line:", line);
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 60_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function run() {
  // 1. initialize
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  console.log("[smoke] initialize →", init.result?.serverInfo);
  notify("notifications/initialized", {});

  // 2. list tools
  const tools = await send("tools/list", {});
  console.log("[smoke] tools:", tools.result?.tools?.map((t) => t.name));

  // 3. call generate_thumbnail
  const call = await send("tools/call", {
    name: "generate_thumbnail",
    arguments: {
      title: "Smoke test — how to bake sourdough at home",
      format: "youtube",
    },
  });

  if (call.error) {
    console.error("[smoke] JSON-RPC error:", call.error);
    process.exitCode = 1;
  } else {
    const content = call.result?.content || [];
    const textPart = content.find((c) => c.type === "text");
    const imagePart = content.find((c) => c.type === "image");
    console.log("[smoke] text:", textPart?.text);
    console.log(
      "[smoke] image:",
      imagePart
        ? `mimeType=${imagePart.mimeType} base64Bytes=${imagePart.data?.length}`
        : "MISSING",
    );
    console.log("[smoke] isError:", call.result?.isError === true);
    if (!imagePart) process.exitCode = 1;
  }

  child.stdin.end();
  child.kill();
}

run().catch((err) => {
  console.error("[smoke] failed:", err);
  child.kill();
  process.exit(1);
});
