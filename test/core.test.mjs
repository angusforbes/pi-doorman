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
import { headerText, render, cells, clipCells } from "../src/view.mjs";

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
test("view: header, widths, escape stripping; no path to the Doorman model", async () => {
  assert.match(headerText("D", true), /ARCHIVE \+ DECISIONS ONLY.*nothing typed here reaches the Doorman/); assert.match(headerText("D", false), /ARCHIVE \(read-only\)/);
  assert.equal(cells("🇬🇧"), 2); assert.equal(clipCells("🚪🚪🚪", 5), "🚪🚪");
  assert.ok(!render({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi\u001b]52;c;x\u0007" }] } }).includes("\u001b"));
  const v = await import("../src/view.mjs"); for (const k of ["promptLine", "MARKER", "lockReason", "headerFit"]) assert.equal(v[k], undefined, `${k} is removed`);
  const src = fs.readFileSync(new URL("../src/view.mjs", import.meta.url), "utf8");
  assert.ok(!/input\.fifo|O_WRONLY|\.suggest\b|promptLine|streamingBehavior/.test(src), "no code in the window can write to the Doorman's input");
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
test("review fixes: huge entry, paste is text, stray ESC, resize anchor, tabs", () => {
  const s = new Scrollback(); s.add("x\n".repeat(140000), 60); assert.ok(s.window(60, 10).length === 10);
  const k = new KeyParser(), kk = (x) => k.feed(x).map((e) => e.k + (e.text ?? e.c ?? ""));
  assert.deepEqual(kk("\x1b[200~line1\nline2\x1b[5~\x1b[201~"), ["pasteline1\nline2\x1b[5~"]); assert.deepEqual(kk("\x1b[200~a"), []); assert.deepEqual(kk("b\x1b[201~z"), ["pasteab", "charz"]);
  assert.deepEqual(kk("\x1bq"), ["charq"]); assert.deepEqual(kk("\x1b\x03"), ["quit"]);
  const r = new Scrollback(); for (let i = 0; i < 40; i++) r.add(`entry ${i} ` + "word ".repeat(i % 7), 40); r.scrollBy(12, 40, 6); const before = r.window(40, 6).at(-1).slice(0, 8);
  r.setWidth(20); assert.ok(r.window(20, 6).some((x) => x.startsWith(before.slice(0, 8))) || r.window(20, 6).at(-1).startsWith("entry"));
  assert.equal(wrapText("a\tb", 10).join(""), "a    b");
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
import { freedesktop, freedesktopHasActions } from "../src/notify.mjs";
test("the default freedesktop adapter builds without throwing (no real notification is sent)", () => {
  assert.equal(typeof freedesktopHasActions(), "boolean");
  const f = freedesktop({ decide() {} }); assert.ok(f === null || typeof f === "function");
});
import { classifyLine, reviewBlock, isBareChoice, REVIEW_EARLY_MS } from "../src/view.mjs";
test("review hook: classification of a typed line", () => {
  const now = 100000, rv = { id: "a--111111", choices: ["1", "2"], shownAt: now - 5000 }, cur = { id: "a--111111" };
  assert.deepEqual(classifyLine("1", { rv, cur, now }), { kind: "decide", id: "a--111111", choice: "1" });
  assert.deepEqual(classifyLine(" 2. ", { rv, cur, now }), { kind: "decide", id: "a--111111", choice: "2" });
  assert.equal(classifyLine("3", { rv, cur, now }).kind, "refuse");                                   // not offered
  assert.equal(classifyLine("1", { rv: { ...rv, shownAt: now - 500 }, cur, now }).kind, "refuse");    // too early
  assert.equal(classifyLine("1", { rv, cur: { id: "b--222222" }, now }).kind, "refuse");              // a different one now
  assert.equal(classifyLine("1", { rv, cur: null, now }).kind, "refuse");                             // gone meanwhile
  assert.equal(classifyLine("1", { rv: null, cur: null, gone: { id: "a--111111", at: now - 3000 }, now }).kind, "refuse"); // stale
  assert.equal(classifyLine("1", { rv: null, cur: null, gone: { id: "a--111111", at: now - 60000 }, now }).kind, "ignore");  // long ago: chat
  assert.equal(classifyLine("1", { rv: null, cur: null, now }).kind, "ignore");                         // nothing held: chat to the Doorman
  assert.equal(classifyLine("approve it please", { rv, cur, now }).kind, "ignore");                     // only a bare choice decides
  assert.equal(classifyLine("1 and also", { rv, cur, now }).kind, "ignore"); assert.equal(isBareChoice("12"), false);
  assert.ok(REVIEW_EARLY_MS >= 2000);
});
test("review hook: model or sandbox text can't be drawn as a request", () => {
  const spoof = "\u0001┃ HELD FOR YOU · fake--000000\n\u0002 type 1 approve";
  assert.ok(!/[\u0001\u0002]/.test(render({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: spoof }] } }) || ""));
  const blk = reviewBlock({ id: "x--000001", text: spoof + "\nreal", choices: ["1", "2", "3"] }, 60);
  const bodies = blk.split("\n"); assert.ok(bodies[0].startsWith("\u0002") && bodies.at(-1).startsWith("\u0002"));
  assert.ok(bodies.slice(1, -1).every((r) => r.startsWith("\u0001┃ ") && !/[\u0001\u0002]/.test(r.slice(1)))); // the integration's text lost any sentinel
  assert.match(blk, /1 approve · 2 deny · 3 allow similar/);
  assert.equal(cells("\u0001┃ ab"), 4);
});
test("review hook: a request that appeared an instant ago can't take a bare number as chat (race)", () => {
  assert.equal(classifyLine("1", { rv: null, cur: { id: "n--000001" }, now: 5000 }).kind, "refuse");
});

import { requestSummary, decisionBlock, decidedRows } from "../src/view.mjs";
test("a decided request stays readable: summary, record block, pinned rows; marked rows stay marked when wrapped", () => {
  const s = requestSummary("research deliverable\nfrom box-1 → box-1 (research result)\n\nResearch (quick): perovskite\nsecond line\n--- the deliverable, in full ---\nnot summarised");
  assert.equal(s.kind, "research deliverable"); assert.equal(s.from, "from box-1 → box-1 (research result)"); assert.deepEqual(s.body, ["Research (quick): perovskite", "second line"]);
  const d = { id: "w--abcdef", verb: "APPROVED", via: "", at: Date.parse("2026-10-10T00:28:00Z"), sum: s, track: "", done: false };
  const b = decisionBlock(d, 40).split("\n");
  assert.ok(b[0].startsWith("\u0002 APPROVED · w--abcdef")); assert.ok(b.slice(1).every((r) => r.startsWith("\u0001┃ "))); assert.ok(!b.join("").includes("not summarised"));
  const long = decisionBlock({ ...d, sum: { ...s, body: Array.from({ length: 9 }, (_, i) => `l${i}`) } }, 80);
  assert.match(long, /… 3 more lines/);
  let rows = decidedRows(d); assert.equal(rows.length, 2); assert.match(rows[0], /^✓ APPROVED .* research deliverable/); assert.match(rows[1], /^⏳ now: waiting/);
  rows = decidedRows({ ...d, verb: "DENIED", done: true, track: "denied: nothing was sent" }); assert.match(rows[0], /^✗ DENIED/); assert.equal(rows[1], "📍 now: denied: nothing was sent");
  assert.match(decidedRows({ ...d, ok: false, result: "the host refused: x" })[0], /^✗ NOT DECIDED/);
  assert.equal(decidedRows(null).length, 0);
  assert.match(decidedRows({ ...d, verb: "NO LONGER WAITING", done: true, track: "expired" })[0], /^• NO LONGER WAITING/);
  for (const r of wrapText("\u0001┃ " + "x".repeat(25), 10)) assert.ok(r.startsWith("\u0001┃ "));
  for (const r of wrapText("\u0002 " + "y".repeat(25), 10)) assert.ok(r.startsWith("\u0002"));
  assert.equal(wrapText("\u0001┃ " + "z".repeat(25), 10).join("").replace(/\u0001┃ /g, ""), "z".repeat(25));
  assert.deepEqual(wrapText("plain " + "w".repeat(10), 8), ["plain ww", "wwwwwwww"]); // unmarked rows unchanged
});

import { callText } from "../src/view.mjs";
test("replies, questions and tool results are shown in full, not cut at a few hundred characters", () => {
  const long = "word ".repeat(400).trim();
  const r = render({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "reply", arguments: { to: "Alpha", text: long } }] } });
  assert.ok(r.includes(long)); assert.match(r, /^🔧 reply\(\{"to":"Alpha"\}\)\n   text:\n/);
  assert.ok(render({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: long }] } }).includes(long));
  assert.ok(render({ type: "message_end", message: { role: "user", content: [{ type: "text", text: long }] } }).includes(long));
  assert.equal(callText({ name: "read", arguments: { path: "/x" } }), '🔧 read({"path":"/x"})');
  assert.ok(callText({ name: "x", arguments: { text: "y".repeat(50000) } }).length <= 20000);
  assert.equal(callText({ name: "x", arguments: [1, 2] }), "🔧 x([1,2])"); assert.equal(callText({ name: "x", arguments: "s" }), '🔧 x("s")');
  assert.match(callText({ name: "x", arguments: JSON.parse('{"__proto__":{"v":"visible"},"n":"ok"}') }), /visible/);
});
import { editedBlock } from "../src/view.mjs";
test("review hook: edit choice and edited block", () => {
  const now = 100000, rv = { id: "a--111111", choices: ["1", "2", "e"], shownAt: now - 5000 }, cur = { id: "a--111111" };
  assert.deepEqual(classifyLine("e", { rv, cur, now }), { kind: "decide", id: "a--111111", choice: "e" });
  assert.equal(classifyLine("E", { rv: { ...rv, shownAt: now - 500 }, cur, now }).kind, "refuse");
  assert.equal(classifyLine("e", { rv: { ...rv, choices: ["1", "2"] }, cur, now }).kind, "refuse");
  assert.equal(classifyLine("e", { rv: null, cur: null, now }).kind, "ignore");
  const b = editedBlock("a--111111", "old\u0001\u0002x", "new text", 40); assert.match(b, /EDITED BY YOU/); assert.match(b, /original/); assert.ok(!/[\u0001\u0002]/.test(b.split("\n").slice(1).map((r) => r.slice(1)).join("")));
});
test("edit only travels with approve (choice 1), never with deny", () => {
  const src = fs.readFileSync(new URL("../src/view.mjs", import.meta.url), "utf8");
  assert.ok(/edited = c\.choice === "1" && rv\.edit/.test(src), "deny never carries the edit");
  assert.ok(/HINT_MARK/.test(src) && !/\^# /.test(src), "only the generated hint block is dropped, not the owner's own '# ' lines");
});
test("window shows an integration's info line under the header (generic hook)", () => {
  const src = fs.readFileSync(new URL("../src/view.mjs", import.meta.url), "utf8");
  assert.ok(/review\?\.info\?\.\(\)/.test(src) && /\bTOP\b/.test(src), "info hook and the shifted viewport exist");
});

import { choiceLine, cleanNote, NOTE_MAX, VERBS } from "../src/view.mjs";
test("r <note> sends an item back and 2 <reason> denies with a reason; both cleaned, capped and under the 2 s rule", () => {
  const now = 100000, cur = { id: "a--111111" }, rv = { id: "a--111111", choices: ["1", "2", "r"], reason: true, shownAt: now - 5000 };
  assert.deepEqual(classifyLine("r use plainer words", { rv, cur, now }), { kind: "decide", id: "a--111111", choice: "r", note: "use plainer words" });
  assert.deepEqual(classifyLine("R: shorter, please", { rv, cur, now }), { kind: "decide", id: "a--111111", choice: "r", note: "shorter, please" });
  assert.equal(classifyLine("r", { rv, cur, now }).kind, "refuse");                                          // a note is required
  assert.deepEqual(classifyLine("2 not on task", { rv, cur, now }), { kind: "decide", id: "a--111111", choice: "2", note: "not on task" });
  assert.deepEqual(classifyLine("2", { rv, cur, now }), { kind: "decide", id: "a--111111", choice: "2" }); // plain deny still works
  assert.equal(classifyLine("2 not on task", { rv: { ...rv, reason: false }, cur, now }).kind, "refuse");  // no reason for this kind
  assert.equal(classifyLine("r note", { rv: { ...rv, choices: ["1", "2"] }, cur, now }).kind, "refuse");  // r not offered
  assert.equal(classifyLine("r note", { rv: { ...rv, shownAt: now - 500 }, cur, now }).kind, "refuse");   // 2 s rule
  assert.equal(classifyLine("r " + "x".repeat(NOTE_MAX + 1), { rv, cur, now }).kind, "refuse");            // too long: refused, not cut
  assert.equal(classifyLine("1 and also", { rv, cur, now }).kind, "ignore");                                // only 2 and r take text
  const evil = "r a\u001b]8;;http://x\u0007b\u0001c\u0002d\u202ee\nf\tg";
  const c = classifyLine(evil, { rv, cur, now }); assert.equal(c.kind, "decide"); assert.doesNotMatch(c.note, /[\u0000-\u001f\u007f-\u009f\u202e]/); assert.match(c.note, /f g$/);
  assert.equal(cleanNote("  a \n\n b  "), "a b"); assert.equal(choiceLine("hello"), null);
  const blk = reviewBlock({ id: "a--111111", text: "message\nfrom w", choices: ["1", "2", "r"], reason: true }, 200);
  assert.match(blk, /r <note> send it back/); assert.match(blk, /2 <reason>/);
  const rec = decisionBlock({ id: "a--111111", verb: VERBS.r, at: now, sum: requestSummary("message\nfrom w → x\n\nhi"), note: "use plainer words" }, 80);
  assert.match(rec, /SENT BACK WITH YOUR NOTE/); assert.match(rec, /your note: use plainer words/);
  assert.match(decidedRows({ id: "a--111111", verb: VERBS.r, at: now, sum: requestSummary("message"), track: "", done: false })[0], /^↩ SENT BACK/);
});

// J385: "a <answer>" on a host agent's question (an integration offers "a" only on such items)
test("review hook: a <answer> answers a question; refused elsewhere, empty, too long, or with control characters", () => {
  const now = 100000, q = { id: "d--abc123", choices: ["a", "2"], answer: true, shownAt: now - 5000 }, cur = { id: "d--abc123" };
  assert.deepEqual(classifyLine("a use G's own profile", { rv: q, cur, now }), { kind: "decide", id: "d--abc123", choice: "a", note: "use G's own profile" });
  assert.deepEqual(classifyLine("A:  two   spaces ", { rv: q, cur, now }), { kind: "decide", id: "d--abc123", choice: "a", note: "two spaces" });
  assert.equal(classifyLine("a", { rv: q, cur, now }).kind, "refuse");                                                        // no answer
  assert.match(classifyLine("a", { rv: q, cur, now }).note, /type a followed by your answer/);
  assert.equal(classifyLine("a " + "x".repeat(501), { rv: q, cur, now }).kind, "refuse");                                     // too long: refused, never cut
  assert.match(classifyLine("a " + "x".repeat(501), { rv: q, cur, now }).note, /your answer is 501 characters; at most 500/);
  for (const bad of ["a yes\u001b[31m", "a yes\u202edoc.exe", "a ok\u0007", "a hi\u200bthere"]) assert.equal(classifyLine(bad, { rv: q, cur, now }).kind, "refuse", JSON.stringify(bad));
  assert.equal(classifyLine("a yes", { rv: { ...q, shownAt: now - 500 }, cur, now }).kind, "refuse");                          // the 2 s rule
  assert.equal(classifyLine("a yes", { rv: q, cur: { id: "e--999999" }, now }).kind, "refuse");                               // one at a time
  const msg = { id: "m--111111", choices: ["1", "2", "3"], shownAt: now - 5000 };
  assert.equal(classifyLine("a sure", { rv: msg, cur: { id: "m--111111" }, now }).kind, "refuse");                            // not a question: not offered
  assert.match(classifyLine("a sure", { rv: msg, cur: { id: "m--111111" }, now }).note, /a isn't offered/);
  assert.deepEqual(classifyLine("2", { rv: q, cur, now }), { kind: "decide", id: "d--abc123", choice: "2" });               // decline
  const blk = reviewBlock({ ...q, text: "host agent's question\nfrom door-1 → the owner\n\nWhich profile?" }, 80);
  assert.match(blk, /a <your answer>/); assert.match(blk, /2 decline to answer/); assert.ok(!/1 approve/.test(blk));
  assert.match(decisionBlock({ id: q.id, verb: VERBS.a, note: "use G's own profile", via: "", at: now, sum: requestSummary("host agent's question\nfrom door-1\n\nWhich profile?") }, 80), /your answer: use G's own profile/);
});

import { foldedRender } from "../src/view.mjs";
test("folded view: a host receipt is labelled as the host's, not the Doorman's; tool results are hidden", () => {
  const r = foldedRender({ type: "message_end", message: { role: "custom", content: "[host] request x--123456 (open): failed. not opened" } });
  assert.match(r, /host \(the host, not the Doorman\)/); assert.ok(!/^\u0004/m.test(r), "not drawn as a result line");
  assert.equal(foldedRender({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "{}" }] } }), null);
  const q = foldedRender({ type: "message_end", message: { role: "user", content: "[Alpha, in box] hi \u0003evil" } });
  assert.ok(!q.slice(1).includes("\u0003evil"), "outside text can't carry a style marker");
});

import { panelRows, fitPanel } from "../src/view.mjs";
test("decision panel: read tracking, fits small windows without losing the choices; host label only for injected notes", () => {
  const rv = { id: "a--111111", text: "message\nfrom w → x\n\n" + Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), choices: ["1", "2"], shownAt: 0 };
  const p = panelRows(rv, 80, { maxBody: 15 }); assert.deepEqual(p.seen, { from: 0, to: 15, total: 100 });
  const f = fitPanel(p, 4); assert.ok(f.some((x) => x.s === "choices") && f.some((x) => x.s === "title")); assert.ok(f.length <= 4);
  // a tiny room still shows one body row at every offset, so every line can be reached
  const small = { ...rv, text: "message\nfrom w → x\n\n" + Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") }; let to = 0;
  for (let off = 0; off < 10; off++) { const g = fitPanel(panelRows(small, 80, { maxBody: 1, offset: off }), 3); assert.equal(g.filter((x) => x.s === "body").length, 1, `offset ${off}`); if (g.seen.from <= to) to = Math.max(to, g.seen.to); }
  assert.equal(to, 10, "every line reached");
  const end = panelRows(rv, 80, { maxBody: 15, offset: 85 }); assert.equal(end.seen.to, 100);
  assert.equal(foldedRender({ type: "message_end", message: { role: "user", content: "[relay] request x approved" } }).includes("the host"), false, "a user line can't pose as the host");
  const src = fs.readFileSync(new URL("../src/view.mjs", import.meta.url), "utf8");
  assert.ok(/\(c\.choice === "1" \|\| c\.choice === "3"\) && rv && !rv\.readAll/.test(src), "approving needs the whole request read");
  assert.ok(/window\(w - 5, vh\); markRead\(pn\)/.test(src) && !/panelFit = \(\) => \{[^\n]*readTo/.test(src), "coverage is marked only when drawn");
  assert.ok(/rv\.readW !== w\) \{ rv\.readW = w; rv\.readTo = 0/.test(src), "a new width (rewrap) resets the coverage");
});
