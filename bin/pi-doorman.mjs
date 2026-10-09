#!/usr/bin/env node
// pi-doorman CLI. Host side: init, serve, review, queue, approve, deny, card. Sandbox side: ask, request, mcp, hook, card-show.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dirs, okName, readConfig } from "../src/paths.mjs";
import { buildHostCard } from "../src/card.mjs";
import { createService, serve } from "../src/service.mjs";
import { terminalReview } from "../src/review.mjs";
import { notifier } from "../src/notify.mjs";
import { send, readCard } from "../src/client.mjs";
import { runMcp } from "../src/mcp.mjs";
import { runHook } from "../src/hook.mjs";
import { runView } from "../src/view.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flags = (a) => { const f = { _: [], mount: [], allow: [] }; for (let i = 0; i < a.length; i++) { const x = a[i]; if (x.startsWith("--")) { const k = x.slice(2); if (k === "mount" || k === "allow") f[k].push(a[++i]); else if (a[i + 1] && !a[i + 1].startsWith("--")) f[k] = a[++i]; else f[k] = true; } else f._.push(x); } return f; };
const need = (n) => { if (!okName(n)) { console.error("a sandbox NAME is required (letters, digits, . _ -)"); process.exit(2); } return n; };
const USAGE = `pi-doorman: a doorman for sandboxed agents

host:     init NAME [--mount rw:/path[:what]]... [--allow domain]... [--host "My laptop"]
          serve NAME            run the Doorman (rules, optional model, queue)
          review NAME           approve or deny pending requests in this terminal
          queue NAME | approve NAME ID CODE | deny NAME ID
          log NAME | view NAME [--write]   the event log and the developer / observer window (Pi RPC)
inside:   ask "question" | request "what" [--why "..."] | card | mcp | hook | mcp-config | hook-config
Standalone state is ~/.pi-doorman/NAME/ (PI_DOORMAN_HOME overrides). Docs: README.md`;

async function main() {
  if (cmd === "init") {
    const f = flags(rest), name = need(f._[0]), d = dirs(name);
    for (const x of [d.root, d.outbox, d.inbox, d.queue, d.card]) fs.mkdirSync(x, { recursive: true });
    fs.chmodSync(d.root, 0o700); fs.chmodSync(d.queue, 0o700);
    const mounts = f.mount.map((s) => { const [mode, p, ...w] = s.split(":"); return { mode, path: p, what: w.join(":") }; });
    fs.writeFileSync(path.join(d.card, "host-card.md"), buildHostCard({ host: f.host || "the host", sandbox: name, mounts }));
    fs.writeFileSync(path.join(d.card, "net-allowlist.md"), "# Network allowlist\n\n" + (f.allow.length ? f.allow.map((a) => `- ${a}`).join("\n") + "\n" : "(not provided)\n"));
    if (!fs.existsSync(d.config)) fs.writeFileSync(d.config, JSON.stringify({ mode: "doorman-safe", visibility: "strict", runners: {}, plugins: [] }, null, 1));
    console.log(`created ${d.root}\nmount into the sandbox: ${d.outbox} (read-write) and ${d.inbox}, ${d.card} (read-only)\nthen run: pi-doorman serve ${name}`);
  } else if (cmd === "serve") {
    const name = need(rest[0]); let svc; svc = createService(name, { notify: (e) => notifier({ decide: (...a) => svc.decide(...a), reviewCmd: `pi-doorman review ${name}` })(e) });
    console.log(`pi-doorman serving ${name} (${svc.dirs.root})`);
    fs.mkdirSync(svc.dirs.outbox, { recursive: true }); fs.mkdirSync(svc.dirs.inbox, { recursive: true });
    for (;;) { await svc.pump(); await new Promise((r) => setTimeout(r, 700)); }
  } else if (cmd === "review") { const n = await terminalReview(createService(need(rest[0]))); console.log(`${n} decided`); }
  else if (cmd === "queue") for (const e of createService(need(rest[0])).list()) console.log(`${e.status}\t${e.id}\t${e.code}\t${e.summary.split("\n")[0]}`);
  else if (cmd === "approve" || cmd === "deny") console.log((await createService(need(rest[0])).decide(rest[1], cmd === "approve", rest[2])).text);
  else if (cmd === "ask") { const r = await send({ kind: "ask", text: rest.join(" ") }); console.log(r.text); }
  else if (cmd === "request") { const f = flags(rest); const r = await send({ kind: f.kind || "request", text: f._.join(" "), why: f.why, action: f.action }); console.log(`${r.status}: ${r.text}`); }
  else if (cmd === "card") console.log(readCard());
  else if (cmd === "mcp") runMcp();
  else if (cmd === "hook") { let b = ""; process.stdin.on("data", (d) => (b += d)).on("end", () => { const o = runHook(b); if (o) console.log(o); }); }
  else if (cmd === "log" || cmd === "view" || cmd === "fifo-line") runView(cmd, rest[0], rest[1]);
  else if (cmd === "mcp-config") console.log(`Claude Code:  claude mcp add pi-doorman -- npx -y pi-doorman mcp\nCodex (~/.codex/config.toml):\n[mcp_servers.pi-doorman]\ncommand = "npx"\nargs = ["-y", "pi-doorman", "mcp"]\nPi:  pi install git:github.com/angusforbes/pi-doorman`);
  else if (cmd === "hook-config") console.log(JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash|WebFetch", hooks: [{ type: "command", command: "npx -y pi-doorman hook" }] }], PostToolUseFailure: [{ matcher: "Bash|WebFetch", hooks: [{ type: "command", command: "npx -y pi-doorman hook" }] }] } }, null, 2));
  else { console.log(USAGE); process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0); }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
