// The sandbox side: write a message to the outbox, wait for the reply in the inbox. Used by the CLI, the MCP server and the hook.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const sandboxDirs = () => ({ outbox: process.env.PI_DOORMAN_OUTBOX || "/home/agent/.pi-doorman/outbox", inbox: process.env.PI_DOORMAN_INBOX || "/home/agent/.pi-doorman/inbox", card: process.env.PI_DOORMAN_CARD || "/home/agent/.sandbox" });
export async function send(msg, { dirs = sandboxDirs(), timeoutMs = 90000, intervalMs = 400 } = {}) {
  const id = crypto.randomUUID().slice(0, 12);
  const body = JSON.stringify({ ...msg, id });
  fs.mkdirSync(dirs.outbox, { recursive: true });
  fs.writeFileSync(path.join(dirs.outbox, `.${id}.tmp`), body); fs.renameSync(path.join(dirs.outbox, `.${id}.tmp`), path.join(dirs.outbox, `${id}.json`));
  const rf = path.join(dirs.inbox, `${id}.reply.json`), until = Date.now() + timeoutMs;
  while (Date.now() < until) { try { return JSON.parse(fs.readFileSync(rf, "utf8")); } catch { /* not yet */ } await new Promise((r) => setTimeout(r, intervalMs)); }
  return { status: "timeout", text: "No answer from the Doorman yet (is it running on the host?)." };
}
export const readCard = (dirs = sandboxDirs()) => { try { return fs.readFileSync(path.join(dirs.card, "host-card.md"), "utf8"); } catch { return "No host card is mounted here."; } };
