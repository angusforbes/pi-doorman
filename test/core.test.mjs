import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modeOf, modeForSandbox, visibilityOf } from "../src/modes.mjs";
import { buildHostCard, parseHostCard, buildSandboxCard } from "../src/card.mjs";
import { answer } from "../src/rules.mjs";
import { createService, LIMITS } from "../src/service.mjs";
import { callTool } from "../src/mcp.mjs";
import { explain, runHook } from "../src/hook.mjs";
import { promptLine, lockReason, headerText, render, cells, clipCells, MARKER } from "../src/view.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pid-"));
const setup = (extra = {}) => {
  process.env.PI_DOORMAN_HOME = tmp();
  const d = { root: path.join(process.env.PI_DOORMAN_HOME, "sb") }; for (const k of ["outbox", "inbox", "queue", "card"]) { d[k] = path.join(d.root, k); fs.mkdirSync(d[k], { recursive: true }); }
  fs.writeFileSync(path.join(d.card, "host-card.md"), buildHostCard({ sandbox: "sb", mounts: [{ mode: "rw", path: "/work/app", what: "workspace" }, { mode: "ro", path: "/work/lib", what: "library" }] }));
  fs.writeFileSync(path.join(d.card, "net-allowlist.md"), "- github.com\n- *.pypi.org\n");
  return { d, svc: createService("sb", { config: { runners: {}, ...extra }, model: null }) };
};
const put = (d, o) => fs.writeFileSync(path.join(d.outbox, `${o.id}.json`), JSON.stringify(o));
const rep = (d, id) => JSON.parse(fs.readFileSync(path.join(d.inbox, `${id}.reply.json`), "utf8"));

test("modes: default, exact names, unknown, ambiguous", () => {
  assert.equal(modeOf(null).mode, "doorman-safe"); assert.equal(modeOf({ mode: "doorman-open" }).mode, "doorman-open");
  assert.equal(modeOf({ mode: "open" }).mode, "doorman-safe"); assert.ok(modeOf({ mode: 5 }).note);
  assert.equal(visibilityOf("developer"), "developer"); assert.equal(visibilityOf("x"), "strict");
  const t = tmp(); fs.writeFileSync(path.join(t, "a.json"), JSON.stringify({ sandbox: "s", doorman: { mode: "doorman-open" } }));
  assert.equal(modeForSandbox(t, "s").mode, "doorman-open");
  fs.writeFileSync(path.join(t, "b.json"), JSON.stringify({ sandbox: "s" })); assert.equal(modeForSandbox(t, "s").mode, "doorman-strict");
  assert.equal(modeForSandbox(t, "none").mode, "doorman-safe");
});
test("cards: build, parse, sandbox card", () => {
  const c = parseHostCard(buildHostCard({ sandbox: "x", mounts: [{ mode: "rw", path: "/a", what: "w|x" }] }));
  assert.equal(c.header.card, "host-card/1"); assert.deepEqual(c.mounts.map((m) => [m.mode, m.path]), [["rw", "/a"]]);
  assert.match(buildSandboxCard({ sandbox: "x" }), /sandbox-card\/1/);
});
test("rules: path, domain, shares; unknown returns null", () => {
  const cardMd = buildHostCard({ mounts: [{ mode: "ro", path: "/work/lib", what: "" }] }), allowMd = "- github.com\n- *.pypi.org\n";
  assert.match(answer("can I write /work/lib/x.txt?", { cardMd, allowMd }).answer, /READ-ONLY/);
  assert.match(answer("is /etc/passwd shared", { cardMd, allowMd }).answer, /isn't one of the shared/);
  assert.match(answer("why is example.com refused", { cardMd, allowMd }).answer, /not on the allowlist/);
  assert.match(answer("can I reach files.pypi.org", { cardMd, allowMd }).answer, /on the allowlist/);
  assert.equal(answer("what is the meaning of life", { cardMd, allowMd }), null);
});
test("service: ask answered by rules; unknown says not on card", async () => {
  const { d, svc } = setup(); put(d, { id: "q1111", kind: "ask", text: "can I write /work/lib/a?" }); put(d, { id: "q2222", kind: "ask", text: "tell me a joke" });
  await svc.pump(); assert.equal(rep(d, "q1111").by, "rules"); assert.match(rep(d, "q2222").text, /isn't on your host card/);
  assert.deepEqual(fs.readdirSync(d.outbox), []);
});
test("service: request is queued, not granted; approve with binding code and runner", async () => {
  const out = path.join(tmp(), "ran.txt"); const { d, svc } = setup({ runners: { request: `cat > ${out}` } });
  put(d, { id: "r1111", kind: "request", text: "allow pypi.org", why: "pip install" }); await svc.pump();
  const e = svc.list()[0]; assert.equal(e.status, "pending"); assert.equal(rep(d, "r1111").status, "drafted"); assert.equal(fs.existsSync(out), false);
  assert.equal((await svc.decide("r1111", true, "zzzz")).ok, false);
  assert.equal((await svc.decide("r1111", true, e.code)).ok, true);
  assert.match(fs.readFileSync(out, "utf8"), /allow pypi\.org/); assert.equal(rep(d, "r1111").status, "approved");
  assert.equal((await svc.decide("r1111", false)).ok, false); // already decided
});
test("service: deny; no runner says apply by hand", async () => {
  const { d, svc } = setup(); put(d, { id: "r2222", kind: "request", text: "x" }); put(d, { id: "r3333", kind: "request", text: "y" }); await svc.pump();
  assert.match((await svc.decide("r2222", true, svc.list().find((x) => x.id === "r2222").code)).text, /by hand/); assert.match((await svc.decide("r3333", false)).text, /Denied/);
});
test("service: secrets refused, unknown kind refused, symlink and junk ignored, rate limit", async () => {
  const { d, svc } = setup();
  put(d, { id: "s1111", kind: "request", text: `use ghp_${"a".repeat(24)}` }); put(d, { id: "s2222", kind: "nope", text: "x" });
  fs.symlinkSync("/etc/passwd", path.join(d.outbox, "s3333.json")); fs.writeFileSync(path.join(d.outbox, "s4444.json"), "not json");
  await svc.pump(); assert.equal(rep(d, "s1111").status, "refused"); assert.equal(rep(d, "s2222").status, "refused"); assert.equal(fs.existsSync(path.join(d.inbox, "s3333.reply.json")), false); assert.equal(svc.list().length, 0);
  for (let i = 0; i < LIMITS.perMinute + 2; i++) put(d, { id: `l${String(i).padStart(4, "0")}`, kind: "ask", text: "hi" });
  await svc.pump(); assert.equal(rep(d, `l${String(LIMITS.perMinute + 1).padStart(4, "0")}`).status, "refused");
});
test("service: control characters are stripped from messages", async () => {
  const { d, svc } = setup(); put(d, { id: "c1111", kind: "request", text: "a\u001b]52;c;AAAA\u0007b" }); await svc.pump();
  assert.ok(!/[\u001b\u0007]/.test(svc.list()[0].summary));
});
test("service: a plug-in kind runs through the same queue", async () => {
  const { d, svc } = setup(); const p = path.join(tmp(), "k.mjs"); fs.writeFileSync(p, `export default { name: "lease", precheck: (m) => (m.text.length > 20 ? "too long" : null), render: (m) => "Lease: " + m.text };`);
  const s2 = createService("sb", { config: { plugins: [p] }, model: null });
  put(d, { id: "k1111", kind: "lease", text: "gpu 1h" }); put(d, { id: "k2222", kind: "lease", text: "x".repeat(30) }); await s2.pump();
  assert.equal(rep(d, "k1111").status, "drafted"); assert.match(rep(d, "k2222").text, /too long/);
});
test("service: a model answers when rules can't (injected)", async () => {
  const { d } = setup(); const svc = createService("sb", { config: {}, model: async (q, card) => `model saw ${card.includes("host-card/1")}` });
  put(d, { id: "m1111", kind: "ask", text: "tell me about the building" }); await svc.pump(); assert.equal(rep(d, "m1111").text, "model saw true");
});
test("mcp tools talk to the service through the drop-box", async () => {
  const { d, svc } = setup(); const dirs = { outbox: d.outbox, inbox: d.inbox, card: d.card };
  const pumping = setInterval(() => svc.pump(), 50);
  try {
    assert.match(await callTool("ask_doorman", { question: "can I write /work/app/a" }, { dirs, intervalMs: 50 }), /writable/);
    assert.match(await callTool("request", { what: "a thing", why: "because" }, { dirs, intervalMs: 50 }), /^drafted:/);
    assert.match(await callTool("card", {}, { dirs }), /host-card\/1/);
  } finally { clearInterval(pumping); }
});
test("hook explains walls and ignores others", () => {
  assert.match(explain("curl: (22) 403 Blocked by org policy"), /network policy/); assert.match(explain("Read-only file system"), /read-only/);
  assert.equal(explain("all fine"), null); assert.equal(runHook(JSON.stringify({ tool_response: "ok" })), "");
  assert.match(JSON.parse(runHook(JSON.stringify({ hook_event_name: "PostToolUse", tool_response: "EROFS" }))).hookSpecificOutput.additionalContext, /pi-doorman/);
});
test("view: marker prompt, locks, header, widths, escape stripping", () => {
  const l = JSON.parse(promptLine("hello \u001b[2J  there")); assert.ok(l.message.startsWith(MARKER)); assert.ok(!l.message.includes("\u001b")); assert.equal(promptLine("   "), null);
  assert.equal(lockReason({ write: false }), "read-only"); assert.equal(lockReason({ write: true, unitActive: false }), "Doorman offline");
  assert.match(lockReason({ write: true, unitActive: true, state: "working", lastQuestion: "q" }), /busy/); assert.equal(lockReason({ write: true, unitActive: true, state: "idle" }), "");
  assert.match(headerText("D", true, ""), /DEVELOPER MODE.*typing on/); assert.match(headerText("D", false, "read-only"), /OBSERVER \(read-only\).*🔒/);
  assert.equal(cells("🇬🇧"), 2); assert.equal(clipCells("🚪🚪🚪", 5), "🚪🚪");
  assert.ok(!render({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi\u001b]52;c;x\u0007" }] } }).includes("\u001b"));
});
import { notifier, ADAPTERS } from "../src/notify.mjs";
test("notifier always returns a callable, and adapters exist for each platform", () => {
  assert.equal(typeof notifier({ decide() {} }), "function"); assert.deepEqual(Object.keys(ADAPTERS).sort(), ["darwin", "linux", "win32"]);
});
import { readBounded } from "../src/service.mjs";
import { runMcp, validate } from "../src/mcp.mjs";
import { PassThrough } from "node:stream";
test("review fixes: id reuse dropped, decide once, code required, fifo/symlink safe, queue counts pending", async () => {
  const { d, svc } = setup(); put(d, { id: "i1111", kind: "request", text: "one" }); await svc.pump(); const code = svc.list()[0].code;
  put(d, { id: "i1111", kind: "request", text: "REPLACED" }); await svc.pump(); assert.equal(svc.list().length, 1); assert.match(svc.list()[0].summary, /one/);
  assert.equal((await svc.decide("i1111", true)).ok, false); // no code
  const [a, b] = await Promise.all([svc.decide("i1111", true, code), svc.decide("i1111", true, code)]); assert.equal([a, b].filter((x) => x.ok).length, 1);
  put(d, { id: "i2222", kind: "request", text: "two" }); await svc.pump(); assert.equal((await svc.decide("i1111", false)).ok, false);
  const fifo = path.join(d.outbox, "f.json"); try { (await import("node:child_process")).execFileSync("mkfifo", [fifo]); } catch { /* */ }
  assert.equal(readBounded(fifo, 1000), null); fs.symlinkSync("/etc/hostname", path.join(d.outbox, "g.json")); assert.equal(readBounded(path.join(d.outbox, "g.json"), 1000), null);
  await svc.pump(); assert.equal(fs.existsSync(fifo), false);
});
test("review fixes: too-large and secret fields refused, even for ask", async () => {
  const { d, svc } = setup(); put(d, { id: "t1111", kind: "draft", text: "x", patch: "p".repeat(7000) }); put(d, { id: "t2222", kind: "ask", text: "my key is " + "AK" + "IAABCDEFGHIJKLMNOP" }); put(d, { id: "t3333", kind: "request", text: "x", action: "-----BEGIN RSA " + "PRIVATE KEY-----" });
  await svc.pump(); for (const i of ["t1111", "t2222", "t3333"]) assert.equal(rep(d, i).status, "refused"); assert.equal(svc.list().length, 0);
});
test("review fixes: flooded refusals don't fill the queue forever (pending only)", async () => {
  const { d, svc } = setup(); for (let i = 0; i < 3; i++) { put(d, { id: `p${i}111`, kind: "request", text: "x" }); } await svc.pump();
  for (const e of svc.list()) await svc.decide(e.id, false); put(d, { id: "p9999", kind: "request", text: "later" }); await svc.pump(); assert.equal(rep(d, "p9999").status, "drafted");
});
test("mcp protocol: errors, null, version, bad args", async () => {
  const i = new PassThrough(), o = new PassThrough(), got = []; o.on("data", (b) => got.push(...String(b).trim().split("\n").map((l) => JSON.parse(l)))); runMcp(i, o, {});
  i.write("not json\nnull\n" + JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request", arguments: {} } }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }) + "\n");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got[0].error.code, -32700); assert.equal(got[1].error.code, -32600); assert.equal(got[2].result.protocolVersion, "2025-06-18"); assert.equal(got[3].error.code, -32602); assert.equal(got[4].error.code, -32602);
  assert.equal(validate("ask_doorman", { question: "x" }), null);
});
test("decide: a stale first read can't double-run (re-checked under the claim)", async () => {
  const { d, svc } = setup(); put(d, { id: "z1111", kind: "request", text: "x" }); await svc.pump(); const code = svc.list()[0].code;
  assert.equal((await svc.decide("z1111", true, code)).ok, true); // now approved
  const f = path.join(d.queue, "z1111.json"); const e = JSON.parse(fs.readFileSync(f, "utf8")); assert.equal(e.status, "approved");
  assert.equal((await svc.decide("z1111", true, code)).ok, false);
});
import { spawnSync } from "node:child_process";
test("the inner guide compiles and runs", () => {
  const g = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "guide", "sandbox-guide");
  assert.equal(spawnSync("python3", ["-c", `import ast,sys; ast.parse(open(${JSON.stringify(g)}).read())`]).status, 0);
  const r = spawnSync("python3", [g, "why", "/nonexistent/x"], { encoding: "utf8" }); assert.equal(r.status, 0); assert.match(r.stdout, /Doorman|host/);
});
test("hidden fields are dropped per kind: what's shown is all that runs", async () => {
  const out = path.join(tmp(), "got.json"); const { d, svc } = setup({ runners: { request: `cat > ${out}` } });
  put(d, { id: "h1111", kind: "request", text: "install a harmless package", target: "/protected", patch: "UNREVIEWED ACTION" }); await svc.pump();
  const e = svc.list()[0]; assert.equal(e.msg.patch, ""); assert.equal(e.msg.target, ""); await svc.decide("h1111", true, e.code);
  assert.ok(!/UNREVIEWED|protected/.test(fs.readFileSync(out, "utf8")));
});
import { wrapText, Scrollback, KeyParser, statusText } from "../src/view.mjs";
test("scrollback: wrapping never cuts, scrolling, no yank, counts new", () => {
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]); assert.equal(wrapText("a\nb", 10).length, 2); assert.equal(wrapText("🚪🚪🚪", 4).join(""), "🚪🚪🚪");
  assert.equal(wrapText("x".repeat(95), 10).join(""), "x".repeat(95));
  const s = new Scrollback(); for (let i = 0; i < 30; i++) s.add(`line ${i}`, 20);
  assert.equal(s.window(20, 5).at(-1), "line 29"); s.scrollBy(10, 20, 5); assert.equal(s.window(20, 5).at(-1), "line 19");
  s.add("fresh", 20); s.add("fresh2", 20); assert.equal(s.window(20, 5).at(-1), "line 19"); assert.equal(s.unseen, 2); assert.match(statusText(s.offset, s.unseen), /2 new/);
  s.top(20, 5); assert.equal(s.window(20, 5)[0], "line 0"); s.scrollBy(1000, 20, 5); assert.equal(s.window(20, 5)[0], "line 0");
  s.live(); assert.equal(s.window(20, 5).at(-1), "fresh2"); assert.equal(s.unseen, 0);
  s.scrollBy(3, 20, 5); s.scrollBy(-99, 20, 5); assert.equal(s.offset, 0);
});
test("keys: wheel, PgUp/PgDn, Shift+arrows, Home/End, split sequences, typing", () => {
  const k = new KeyParser(), kinds = (str) => k.feed(str).map((e) => e.k + (e.c ?? ""));
  assert.deepEqual(kinds("\x1b[<64;10;5M"), ["wheelup"]); assert.deepEqual(kinds("\x1b[<65;10;5M"), ["wheeldown"]); assert.deepEqual(kinds("\x1b[<0;10;5M\x1b[<64;1;1m"), []);
  assert.deepEqual(kinds("\x1b[5~\x1b[6~\x1b[1;2A\x1b[1;2B"), ["pgup", "pgdn", "sup", "sdown"]); assert.deepEqual(kinds("\x1b[H\x1b[F\x1b[1~\x1b[4~"), ["home", "end", "home", "end"]);
  assert.deepEqual(kinds("\x1b"), []); assert.deepEqual(kinds("[A"), []); assert.deepEqual(kinds("hi\r\x7f\x1bOAx"), ["charh", "chari", "enter", "backspace", "charx"]);
});
import { headerFit } from "../src/view.mjs";
test("review fixes: huge entry, paste is text, stray ESC, resize anchor, tabs, header fit", () => {
  const s = new Scrollback(); s.add("x\n".repeat(140000), 60); assert.ok(s.window(60, 10).length === 10);
  const k = new KeyParser(), kk = (x) => k.feed(x).map((e) => e.k + (e.text ?? e.c ?? ""));
  assert.deepEqual(kk("\x1b[200~line1\nline2\x1b[5~\x1b[201~"), ["pasteline1\nline2\x1b[5~"]); assert.deepEqual(kk("\x1b[200~a"), []); assert.deepEqual(kk("b\x1b[201~z"), ["pasteab", "charz"]);
  assert.deepEqual(kk("\x1bq"), ["charq"]); assert.deepEqual(kk("\x1b\x03"), ["quit"]);
  const r = new Scrollback(); for (let i = 0; i < 40; i++) r.add(`entry ${i} ` + "word ".repeat(i % 7), 40); r.scrollBy(12, 40, 6); const before = r.window(40, 6).at(-1).slice(0, 8);
  r.setWidth(20); assert.ok(r.window(20, 6).some((x) => x.startsWith(before.slice(0, 8))) || r.window(20, 6).at(-1).startsWith("entry"));
  assert.equal(wrapText("a\tb", 10).join(""), "a    b");
  assert.match(headerFit("Door-1", true, "busy answering the sandbox's request", 30), /🔒/); assert.match(headerFit("D", true, "", 80), /DEVELOPER MODE/);
});
test("review fixes 2: paste end marker split past the cap, resize keeps the place inside a long entry", () => {
  const p = new KeyParser(); p.feed("\x1b[200~" + "x".repeat(20000) + "\x1b[20"); const e = p.feed("1~"); assert.equal(e[0]?.k, "paste"); assert.deepEqual(p.feed("a").map((x) => x.k), ["char"]);
  const q = new KeyParser(); q.feed("\x1b[200~abc"); assert.deepEqual(q.feed("\x03").map((x) => x.k), ["quit"]);
  const s = new Scrollback(); s.add(Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n"), 60); s.scrollBy(100, 60, 13); const was = s.window(60, 13).at(-1);
  s.setWidth(40); assert.equal(s.window(40, 13).at(-1), was); assert.ok(s.offset > 0);
});
import { notifyArgs } from "../src/notify.mjs";
test("a notification never offers or performs Approve", () => {
  const e = { id: "n1", code: "abcd", summary: "Request: allow x" };
  for (const actions of [true, false]) { const a = notifyArgs(e, { actions }).join(" "); assert.ok(!/approve=|--action=approve/i.test(a)); assert.match(a, /pi-doorman review/); assert.equal(/--action=deny=Deny/.test(a), actions); }
  assert.ok(!notifyArgs({ ...e, summary: "x".repeat(2000) }, { actions: true }).join(" ").includes("--action=approve"));
});
