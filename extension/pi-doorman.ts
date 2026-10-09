// Pi extension: inside a sandbox, gives a Pi agent the same two tools as the MCP server (ask_doorman, request).
// It only writes to the outbox and reads the inbox; it can't approve anything.
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dirs = () => ({ outbox: process.env.PI_DOORMAN_OUTBOX || "/home/agent/.pi-doorman/outbox", inbox: process.env.PI_DOORMAN_INBOX || "/home/agent/.pi-doorman/inbox" });
async function send(msg: Record<string, unknown>): Promise<{ status: string; text: string }> {
  const d = dirs(), id = crypto.randomUUID().slice(0, 12);
  fs.mkdirSync(d.outbox, { recursive: true });
  fs.writeFileSync(path.join(d.outbox, `.${id}.tmp`), JSON.stringify({ id, ...msg }));
  fs.renameSync(path.join(d.outbox, `.${id}.tmp`), path.join(d.outbox, `${id}.json`));
  const until = Date.now() + 90000;
  while (Date.now() < until) { try { return JSON.parse(fs.readFileSync(path.join(d.inbox, `${id}.reply.json`), "utf8")); } catch { /* wait */ } await new Promise((r) => setTimeout(r, 400)); }
  return { status: "timeout", text: "No answer from the Doorman yet." };
}
export default function (pi: any) {
  pi.registerTool({ name: "ask_doorman", label: "Ask the Doorman", description: "Ask the Doorman about this sandbox's walls (shared folders, network allowlist, how to reach the host). Use BEFORE assuming a host file, tool or site exists.", parameters: Type.Object({ question: Type.String() }), async execute(_id: string, p: { question: string }) { const r = await send({ kind: "ask", text: p.question }); return { content: [{ type: "text", text: r.text }], details: r }; } });
  pi.registerTool({ name: "request", label: "Request from the owner", description: "Draft a request for the owner (a folder, a domain, a package, a host action). It waits for approval and is never granted by this call.", parameters: Type.Object({ what: Type.String(), why: Type.Optional(Type.String()) }), async execute(_id: string, p: { what: string; why?: string }) { const r = await send({ kind: "request", text: p.what, why: p.why }); return { content: [{ type: "text", text: `${r.status}: ${r.text}` }], details: r }; } });
}
