// The Doorman service for one sandbox. Rules first, then (optionally) one stateless model call, then a queue of drafted requests.
// It only talks: it never approves anything and runs nothing except a runner the owner configured, after a human approval.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirs, safeText, readConfig } from "./paths.mjs";
import { answer } from "./rules.mjs";
import { loadKinds, scanFields } from "./kinds.mjs";

export const LIMITS = { bytes: 6000, file: 64 * 1024, perMinute: 20, perPump: 50, pending: 50, replyTtlMs: 3600000 };
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT = path.join(here, "..", "prompts", "doorman.md");
const rd = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const wr = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o, null, 1), { mode: 0o644 }); fs.renameSync(f + ".tmp", f); };
const wrNew = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1), { mode: 0o644, flag: "wx" }); }; // fails if it exists: a sandbox can't reuse an id
// Read a sandbox-controlled file safely: no symlinks, no FIFOs, regular files only, bounded size; null if it isn't.
export function readBounded(file, max) {
  let fd; try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.size > max) return null; const b = Buffer.alloc(st.size); let n = 0; while (n < st.size) { const r = fs.readSync(fd, b, n, st.size - n, n); if (!r) break; n += r; } return b.toString("utf8", 0, n); } catch { return null; } finally { fs.closeSync(fd); }
}
const code = () => crypto.randomBytes(2).toString("hex");

// One stateless model call through Pi (optional peer). cfg.model_cmd overrides: a command that takes the prompt on stdin.
export function piModel(cfg = {}) {
  return (question, cardMd) => new Promise((resolve) => {
    const body = `[your host card]\n${cardMd}\n[end of host card]\n\n${question}`;
    const args = cfg.model_cmd ? cfg.model_cmd : ["pi", "-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--system-prompt", rd(PROMPT), ...(cfg.model ? ["--model", cfg.model] : []), body];
    let out = ""; let p;
    try { p = spawn(args[0], args.slice(1), { stdio: ["pipe", "pipe", "ignore"] }); } catch { return resolve(null); }
    p.on("error", () => resolve(null)); p.stdout.on("data", (d) => (out += d)); p.on("close", (c) => resolve(c === 0 && out.trim() ? out.trim() : null));
    if (cfg.model_cmd) p.stdin.end(body); else p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch { /* */ } }, cfg.model_timeout_ms ?? 60000).unref();
  });
}

export function createService(name, opts = {}) {
  const d = dirs(name), cfg = opts.config ?? readConfig(name), model = opts.model === undefined ? (cfg.model_cmd || cfg.model ? piModel(cfg) : null) : opts.model;
  const seen = []; // timestamps, for the rate limit
  const cardMd = () => rd(path.join(d.card, "host-card.md")), allowMd = () => rd(path.join(d.card, "net-allowlist.md"));
  const reply = (id, obj, update = false) => { const f = path.join(d.inbox, `${id}.reply.json`), o = { id, at: new Date().toISOString(), ...obj }; if (update) wr(f, o); else { try { wrNew(f, o); } catch { /* id already used: ignore */ } } };
  const notify = opts.notify ?? (() => {});
  const log = (o) => { try { fs.appendFileSync(path.join(d.root, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n", { mode: 0o600 }); } catch { /* */ } };

  async function handle(raw, file) {
    const kinds = opts.kinds ?? (opts.kinds = await loadKinds(cfg));
    let m; try { m = JSON.parse(raw); } catch { return null; }
    if (!m || typeof m !== "object") return null;
    const id = /^[A-Za-z0-9-]{4,40}$/.test(String(m.id)) ? String(m.id) : path.basename(file, ".json").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || code();
    const msg = { id, kind: String(m.kind || "ask"), text: safeText(m.text).slice(0, 2000), why: safeText(m.why).slice(0, 1000), action: safeText(m.action).slice(0, 1000), target: safeText(m.target).slice(0, 300), patch: m.patch == null ? "" : safeText(String(m.patch)).slice(0, LIMITS.bytes + 1) };
    if (fs.existsSync(path.join(d.queue, `${id}.json`)) || fs.existsSync(path.join(d.queue, `${id}.claim`)) || fs.existsSync(path.join(d.inbox, `${id}.reply.json`))) { log({ id, dropped: "id already used" }); return null; }
    const now = Date.now(); while (seen.length && now - seen[0] > 60000) seen.shift();
    if (seen.length >= LIMITS.perMinute) { reply(id, { status: "refused", text: "Too many messages this minute; slow down." }); return msg; }
    seen.push(now);
    const leak = scanFields(msg); if (leak) { reply(id, { status: "refused", text: `Refused: ${leak}.` }); log({ id, refused: leak }); return msg; }
    if (msg.patch.length > LIMITS.bytes || msg.action.length + msg.text.length + msg.why.length > LIMITS.bytes) { reply(id, { status: "refused", text: `Refused: too large to review in full (limit ${LIMITS.bytes} characters); shorten it or split it.` }); return msg; }
    const kind = kinds[msg.kind];
    if (kind) for (const k of ["text", "why", "action", "target", "patch"]) if (!kind.fields.includes(k)) msg[k] = ""; // fields the kind doesn't show are dropped before anything is checked, queued or run
    if (!kind) { reply(id, { status: "refused", text: `Unknown request kind "${msg.kind}". Kinds here: ${Object.keys(kinds).join(", ")}.` }); return msg; }
    const bad = kind.precheck(msg); if (bad) { reply(id, { status: "refused", text: `Refused: ${bad}.` }); log({ id, kind: msg.kind, refused: bad }); return msg; }
    if (!kind.review) { // ask: rules first, then the model, else say it isn't on the card
      const r = answer(msg.text, { cardMd: cardMd(), allowMd: allowMd() });
      let text = r?.answer, by = "rules";
      if (!text && model) { text = await model(msg.text, cardMd()); by = "model"; }
      if (!text) { text = "That isn't on your host card, so I can't say. If you need it, send a request with kind request."; by = "none"; }
      reply(id, { status: "answered", by, text }); log({ id, kind: "ask", by }); return msg;
    }
    if (list().filter((x) => x.status === "pending").length >= LIMITS.pending) { reply(id, { status: "refused", text: "The owner's queue is full; wait for decisions." }); return msg; }
    let plan = msg; if (kind.plan) plan = (await kind.plan(msg, { cardMd: cardMd(), model })) ?? msg;
    const complaint = kind.check ? kind.check(plan) : null; if (complaint) { reply(id, { status: "refused", text: `Refused: ${complaint}.` }); return msg; }
    const entry = { id, code: code(), kind: msg.kind, status: "pending", at: new Date().toISOString(), msg: plan, summary: kind.render(plan) };
    try { wrNew(path.join(d.queue, `${id}.json`), entry); } catch { return null; }
    reply(id, { status: "drafted", code: entry.code, text: `Drafted and waiting for the owner (code ${entry.code}). It is NOT granted yet; you'll get a reply here when it's decided.` });
    log({ id, kind: msg.kind, drafted: true }); notify(entry); return msg;
  }

  async function pump() {
    let files = []; try { files = fs.readdirSync(d.outbox).filter((f) => f.endsWith(".json")).sort(); } catch { return 0; }
    try { for (const f of fs.readdirSync(d.inbox)) { const p = path.join(d.inbox, f); if (Date.now() - fs.statSync(p).mtimeMs > LIMITS.replyTtlMs && !pendingIds().has(f.replace(/\.reply\.json$/, ""))) fs.rmSync(p, { force: true }); } } catch { /* */ }
    let n = 0;
    for (const f of files) {
      const file = path.join(d.outbox, f);
      if (n >= LIMITS.perPump) { try { fs.unlinkSync(file); } catch { /* */ } continue; } // flood: the rest is dropped unread
      const raw = readBounded(file, LIMITS.file); try { fs.unlinkSync(file); } catch { /* */ }
      if (raw == null) continue;
      n++; try { await handle(raw, file); } catch (e) { log({ error: String(e.message || e).slice(0, 200) }); }
    }
    return n;
  }
  const pendingIds = () => new Set(list().filter((x) => x.status === "pending").map((x) => x.id));
  const list = () => { try { return fs.readdirSync(d.queue).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(d.queue, f), "utf8"))); } catch { return []; } };
  async function decide(id, approve, byCode) {
    const f = path.join(d.queue, `${path.basename(String(id))}.json`), claim = f.replace(/\.json$/, ".claim");
    let e; try { e = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return { ok: false, text: "no such request" }; }
    if (e.status !== "pending") return { ok: false, text: `already ${e.status}` };
    if (approve && (!byCode || byCode !== e.code)) return { ok: false, text: "approving needs the binding code shown with the request" };
    try { fs.renameSync(f, claim); } catch { return { ok: false, text: "already being decided" }; } // atomic claim: only one decider gets past here
    try { e = JSON.parse(fs.readFileSync(claim, "utf8")); } catch { return { ok: false, text: "unreadable request" }; }
    if (e.status !== "pending") { try { fs.renameSync(claim, f); } catch { /* */ } return { ok: false, text: `already ${e.status}` }; } // re-check under the claim (the first read may be stale)
    if (approve && byCode !== e.code) { try { fs.renameSync(claim, f); } catch { /* */ } return { ok: false, text: "approving needs the binding code shown with the request" }; }
    e.status = approve ? "approved" : "denied"; e.decidedAt = new Date().toISOString();
    let text = approve ? "Approved by the owner." : "Denied by the owner.";
    wr(claim, e); // the decision is on disk before anything runs
    if (approve && cfg.runners?.[e.kind]) {
      const r = await new Promise((res) => { const p = spawn(cfg.runners[e.kind], [], { shell: true, stdio: ["pipe", "pipe", "pipe"] }); let o = ""; p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (o += x)); p.on("close", (c) => res({ c, o })); p.stdin.end(JSON.stringify(e.msg)); });
      text += ` Runner ${r.c === 0 ? "finished" : `failed (${r.c})`}: ${safeText(r.o).slice(0, 500)}`; e.runner = r.c;
    } else if (approve) text += " No runner is configured for this kind: the owner will apply it by hand.";
    wr(claim, e); fs.renameSync(claim, f); reply(e.id, { status: e.status, text }, true); log({ id: e.id, decided: e.status });
    return { ok: true, text };
  }
  return { handle, pump, list, decide, dirs: d };
}

export async function serve(name, opts = {}) {
  const svc = createService(name, opts);
  fs.mkdirSync(svc.dirs.outbox, { recursive: true }); fs.mkdirSync(svc.dirs.inbox, { recursive: true });
  for (;;) { await svc.pump(); await new Promise((r) => setTimeout(r, opts.intervalMs ?? 700)); }
}
