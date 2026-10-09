// A minimal stdio MCP server (JSON-RPC 2.0, newline-delimited), no dependencies. Tools: ask_doorman, request, card.
import readline from "node:readline";
import { send, readCard } from "./client.mjs";

const TOOLS = [
  { name: "ask_doorman", description: "Ask the Doorman about this sandbox's walls (shared folders, network allowlist, how to reach the host). Answers come from the host card; use it BEFORE assuming a host file, tool or site exists.", inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
  { name: "request", description: "Ask the owner for something only the host can give (a folder, a domain, a package, a host action). It is drafted and waits for approval; it is never granted by this call.", inputSchema: { type: "object", properties: { what: { type: "string", description: "the single exact thing you need" }, why: { type: "string" }, kind: { type: "string", description: "request (default), draft, or a plug-in kind" }, target: { type: "string" }, patch: { type: "string" } }, required: ["what"] } },
  { name: "card", description: "Read the host card (what the host shares with this sandbox).", inputSchema: { type: "object", properties: {} } },
];
export async function callTool(name, a = {}, opts = {}) {
  if (name === "card") return readCard(opts.dirs);
  if (name === "ask_doorman") { const r = await send({ kind: "ask", text: String(a.question ?? "") }, opts); return r.text; }
  if (name === "request") { const r = await send({ kind: String(a.kind || "request"), text: String(a.what ?? ""), why: a.why, target: a.target, patch: a.patch }, opts); return `${r.status}: ${r.text}`; }
  throw new Error(`unknown tool ${name}`);
}
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const isStr = (v) => typeof v === "string" && v.length > 0;
export function validate(name, a) {
  if (a === undefined) a = {}; if (!a || typeof a !== "object" || Array.isArray(a)) return "arguments must be an object";
  if (name === "ask_doorman" && !isStr(a.question)) return "question (string) is required";
  if (name === "request" && !isStr(a.what)) return "what (string) is required";
  for (const k of ["why", "kind", "target", "patch"]) if (a[k] !== undefined && typeof a[k] !== "string") return `${k} must be a string`;
  return null;
}
export function runMcp(input = process.stdin, output = process.stdout, opts = {}) {
  const out = (o) => output.write(JSON.stringify(o) + "\n");
  const err = (id, code, message) => out({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  readline.createInterface({ input }).on("line", async (line) => {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { return err(null, -32700, "parse error"); }
    if (!m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(m && typeof m === "object" ? m.id : null, -32600, "invalid request");
    const { id, method, params } = m; if (id === undefined) return; // notification
    if (method === "initialize") { const want = params?.protocolVersion; out({ jsonrpc: "2.0", id, result: { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "pi-doorman", version: "0.1.0" } } }); }
    else if (method === "tools/list") out({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    else if (method === "tools/call") {
      if (!TOOLS.some((t) => t.name === params?.name)) return err(id, -32602, `unknown tool ${String(params?.name).slice(0, 40)}`);
      const bad = validate(params.name, params.arguments); if (bad) return err(id, -32602, bad);
      try { out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: await callTool(params.name, params.arguments, opts) }] } }); } catch (e) { out({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message) }] } }); }
    } else if (method === "ping") out({ jsonrpc: "2.0", id, result: {} });
    else err(id, -32601, "method not found");
  });
}
