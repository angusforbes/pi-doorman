// The developer / observer window and the event log. The Doorman's Pi runs in RPC mode; its stdout (JSON events) is piped through
// `log`, and its stdin is a FIFO that only `view --write` feeds.
//   pi-doorman log NAME            stdin events -> events.jsonl (+ status.json: state, last question/answer)
//   pi-doorman view NAME [--write] live render; with --write (developer mode) a prompt line whose text is sent to the Doorman
//                                  marked as the owner's own, never as a sandbox request
// Config by environment (a host integration sets these): PI_DOORMAN_STATE (state root), PI_DOORMAN_MARKER, PI_DOORMAN_LABEL,
// PI_DOORMAN_COLOR (hex, default 3b6ea5), PI_DOORMAN_UNIT_PREFIX (systemd user unit name prefix, default pi-doorman-),
// PI_DOORMAN_REVIEW_MODULE (optional, a host integration's file: its default export createReview(name) returns { current(), decide(id, choice) }; see README "Review hook").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const stateDir = (name) => path.join(process.env.PI_DOORMAN_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-doorman", "view"), name);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const plain = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("") : String(m?.content ?? ""));

// Everything is shown in full (owner: a reply cut at 300 characters looked like a display bug); FULL only guards against a runaway entry.
export const FULL = 20000;
// A tool call: short arguments as JSON on the call line, long text arguments (a reply's text, a message) underneath in full.
export function callText(c) {
  const raw = c?.arguments ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clip(`🔧 ${c?.name}(${JSON.stringify(raw)})`, FULL); // not an object: as it is
  const a = raw, short = Object.create(null), long = []; // (null prototype: an argument named __proto__ is kept)
  for (const [k, v] of Object.entries(a)) (typeof v === "string" && (v.length > 80 || v.includes("\n")) ? long.push([k, v]) : (short[k] = v));
  return clip(`🔧 ${c?.name}(${Object.keys(short).length ? JSON.stringify(short) : ""})${long.map(([k, v]) => `\n   ${k}:\n${v}`).join("")}`, FULL);
}
// One RPC event -> a display entry (or null). Shared by the viewer and the status writer's idea of a Q and A.
export function render(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "agent_start") return "── turn ──";
  if (ev.type === "message_end" && ev.message) {
    const m = ev.message, t = plain(textOf(m)).trim();
    if (m.role !== "assistant" && m.role !== "toolResult") return t ? `${m.role === "custom" && /^\s*\[[A-Za-z0-9_-]{1,20}\]\s/.test(t) ? "⚙ host (not the Doorman): " : "❓ "}${clip(t.replace(/\[your host card[\s\S]*?\[end of host card\]\s*/, "[card] "), FULL)}` : null;
    if (m.role === "assistant") {
      const calls = (m.content || []).filter((c) => c?.type === "toolCall").map(callText);
      return [t && `💬 ${t}`, ...calls, m.stopReason === "error" && `⚠ ${clip(m.errorMessage, 2000)}`].filter(Boolean).join("\n") || null;
    }
    if (m.role === "toolResult") return `   ↳ ${clip(plain(textOf(m)), FULL)}`;
  }
  return null;
}

function log(name) {
  const d = stateDir(name); fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const ev = fs.openSync(path.join(d, "events.jsonl"), "a", 0o600), sf = path.join(d, "status.json");
  let st = { state: "idle", question: "", answer: "", at: "" };
  const save = () => { st.at = new Date().toISOString(); fs.writeFileSync(sf + ".tmp", JSON.stringify(st), { mode: 0o600 }); fs.renameSync(sf + ".tmp", sf); };
  save();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let j; try { j = JSON.parse(line); } catch { return; }
    if (j.type === "message_update" || j.type === "tool_execution_update") return; // streaming deltas: not kept
    fs.writeSync(ev, line + "\n");
    if (j.type === "agent_start") { st.state = "working"; save(); }
    else if (j.type === "agent_end") { st.state = "idle"; save(); }
    else if (j.type === "message_end" && j.message?.role !== "assistant" && j.message?.role !== "toolResult") { const t = plain(textOf(j.message)).replace(/\[your host card[\s\S]*?\[end of host card\]\s*/, "").replace(/\s+/g, " ").trim(); if (t) { st.question = clip(t, 300); st.answer = ""; save(); } }
    else if (j.type === "message_end" && j.message?.role === "assistant") { const t = plain(textOf(j.message)).trim(); if (t) { st.answer = clip(t, 300); save(); } }
  });
}

// ---- the window : a pinned header bar (white on the configured colour) that says which mode this is and whether typing
// is possible right now, the conversation (scrollable: wheel, PgUp/PgDn, Shift+arrows, Home/End), a status line, and an input line that is locked (🔒) with the reason
// whenever a line typed now would not be sent.
// While a review item is on screen the window switches to this colour (header bar, review block, status line, input line); it is chosen
// by the view from its own state, never from passed-through text.
export function reviewHex() { const c = String(process.env.PI_DOORMAN_REVIEW_COLOR || "").replace(/^#/, ""); return /^[0-9A-Fa-f]{6}$/.test(c) ? c : "b3261e"; }
export function worldHex() { const c = String(process.env.PI_DOORMAN_COLOR || "").replace(/^#/, ""); return /^[0-9A-Fa-f]{6}$/.test(c) ? c : "3b6ea5"; }
const rgbOf = (h) => { const n = parseInt(h, 16); return `${n >> 16};${(n >> 8) & 255};${n & 255}`; };
// The window has NO channel to the Doorman model: it is an archive of the conversation plus the place where the owner decides what is held.
// write = this window may take decisions (through the review hook); otherwise it is a pure read-only archive.
export function headerText(label, write) {
  return `🚪 ${label} · ${write ? "ARCHIVE + DECISIONS ONLY" : "ARCHIVE (read-only)"} · nothing typed here reaches the Doorman`;
}
const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const gw = (g) => (/^[\u0001-\u0006]$/.test(g) ? 0 : /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60]/u.test(g) ? 2 : 1);
export const cells = (s) => [...SEG.segment(s)].reduce((n, x) => n + gw(x.segment), 0);
export const clipCells = (s, max) => { let n = 0, o = ""; for (const x of SEG.segment(s)) { const w = gw(x.segment); if (n + w > max) break; n += w; o += x.segment; } return o; };
const tailCells = (s, max) => { const g = [...SEG.segment(s)].map((x) => x.segment); let n = 0, o = ""; for (let i = g.length - 1; i >= 0; i--) { const w = gw(g[i]); if (n + w > max) break; n += w; o = g[i] + o; } return o; };

// ---- scrollback (pure, tested): wrapping never cuts a line, the model keeps the conversation and a viewport offset.
export function wrapText(text, width) {
  const w = Math.max(1, width), rows = [];
  for (const line of String(text).replace(/\t/g, "    ").split("\n")) {
    // a row drawn from the integration (\u0001 body / \u0002 banner) stays marked on every wrapped row, so its colour never breaks off
    const mk = line[0] === "\u0001" ? (line.startsWith("\u0001┃ ") ? "\u0001┃ " : "\u0001") : line[0] === "\u0002" ? "\u0002  " : /^[\u0003-\u0006]/.test(line) ? line[0] + (line[0] === "\u0006" ? "   " : "") : "", mw = cells(mk) < w ? cells(mk) : 0;
    let cur = "", n = 0;
    for (const x of SEG.segment(line)) { const g = gw(x.segment); if (n + g > w && cur && n > mw) { rows.push(cur); cur = mw ? mk : mk[0] || ""; n = mw; } cur += x.segment; n += g; }
    rows.push(cur);
  }
  return rows;
}
export class Scrollback {
  constructor(max = 3000) { this.entries = []; this.max = max; this.offset = 0; this.unseen = 0; this.w = 0; this.cache = []; }
  rowsFor(i, width) { return (this.cache[i] ??= wrapText(this.entries[i], width)); }
  all(width) { this.setWidth(width); const r = []; for (let i = 0; i < this.entries.length; i++) for (const row of this.rowsFor(i, width)) r.push(row); return r; }
  // A new width re-wraps everything; while scrolled up, the view stays anchored on the same entry (not the same row number).
  setWidth(width) {
    if (width === this.w) return;
    let anchor = -1, within = 0, oldRows = 1;
    if (this.offset > 0 && this.w > 0) { let end = 0; for (let i = 0; i < this.entries.length; i++) end += this.rowsFor(i, this.w).length; let at = end - this.offset, cum = 0; for (let i = 0; i < this.entries.length; i++) { const n = this.rowsFor(i, this.w).length; cum += n; if (cum >= at) { anchor = i; within = cum - at; oldRows = n; break; } } }
    this.w = width; this.cache = [];
    if (anchor >= 0) { let total = 0, upto = 0, nr = 1; for (let i = 0; i < this.entries.length; i++) { const n = this.rowsFor(i, width).length; total += n; if (i <= anchor) { upto = total; nr = n; } } this.offset = total - upto + Math.min(nr, Math.round(within * nr / oldRows)); } // same place inside the entry, not its end
  }
  add(text, width, max = 20000) { // a new entry: the view stays where it is while scrolled up (and counts what's new)
    this.setWidth(width);
    const t = String(text).slice(0, max), before = this.offset > 0 ? wrapText(t, width).length : 0;
    this.entries.push(t); if (this.entries.length > this.max) { this.entries.shift(); this.cache.shift(); this.base = (this.base || 0) + 1; }
    if (this.offset > 0) { this.offset += before; this.unseen++; }
    return (this.base || 0) + this.entries.length - 1; // a lasting index for set()
  }
  set(li, text, width) { const i = li - (this.base || 0); if (i < 0 || i >= this.entries.length) return false; this.setWidth(width); this.entries[i] = String(text).slice(0, 20000); this.cache[i] = undefined; return true; }
  clamp(width, height) { const total = this.all(width).length; this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - height))); }
  scrollBy(rows, width, height) { this.offset += rows; this.clamp(width, height); if (this.offset === 0) this.unseen = 0; }
  top(width, height) { this.offset = Math.max(0, this.all(width).length - height); }
  live() { this.offset = 0; this.unseen = 0; }
  window(width, height) { this.clamp(width, height); const r = this.all(width), end = r.length - this.offset; return r.slice(Math.max(0, end - height), end); }
}
export const statusText = (offset, unseen) => (offset > 0 ? `↑ scrolled · End for live${unseen ? ` · ${unseen} new` : ""} · PgUp/PgDn, wheel, Home` : "wheel / PgUp / PgDn / Shift+arrows scroll · End = live");

// ---- the review hook (generic): a host integration may show ONE held request at a time, from its own trusted record, and take a
// bare choice (1 / 2 / 3) typed in this window. The window never decides anything itself; the integration's decide() does, and the
// choice never goes to the Doorman model. Rows drawn from the integration start with \u0001 (body) or \u0002 (banner): plain() strips
// those control characters from every sandbox / model string, so nothing the Doorman or a sandbox says can be drawn as a request.
export const REVIEW_EARLY_MS = 2000, REVIEW_STALE_MS = 10000;
export const isBareChoice = (line) => /^[123e][.)]?$/i.test(String(line ?? "").trim());
// "r <note>": send the held item back to whoever wrote it, with the owner's note (it is withdrawn, not approved; a revision comes back as a new item).
// "2 <reason>": deny, and the asker is told the reason. A note or reason is the owner's own text going to the sandbox: control characters out,
// whitespace collapsed, at most NOTE_MAX characters (a longer one is refused, never cut).
export const NOTE_MAX = 500;
export const cleanNote = (s) => plain(String(s ?? "")).replace(/\s+/g, " ").trim();
// "a <answer>" (J385): the owner's answer to a question a host agent asked about a job (an integration offers "a" only on such items). Like a
// note, but text with control or format characters is refused outright, not cleaned (bad: true), so what reaches the agent is what he typed.
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/u;
export function choiceLine(line) {
  const t = String(line ?? "").trim();
  if (isBareChoice(t)) return { k: t[0].toLowerCase(), note: "" };
  if (/^[ra][.):]?$/i.test(t)) return { k: t[0].toLowerCase(), note: "" };
  const m = /^([2ra])[.):]?\s+(\S[\s\S]*)$/i.exec(t);
  return m ? { k: m[1].toLowerCase(), note: cleanNote(m[2]), ...(CTRL.test(m[2]) ? { bad: true } : {}) } : null;
}
export function reviewBlock(rv, width) {
  const w = Math.max(10, width), rows = wrapText(plain(rv.text).replace(/\r/g, ""), w - 3).map((r) => `\u0001┃ ${r}`);
  const offer = rv.choices.map((c) => (c === "a" ? "a <your answer> (it goes to the host agent working the job)" : c === "1" ? (rv.edit ? "1 approve YOUR EDITED version" : "1 approve") : c === "2" ? (rv.answer ? "2 decline to answer" : rv.reason ? "2 deny (or 2 <reason>: the asker is told why)" : "2 deny") : c === "e" ? (rv.edit ? "e edit again" : "e edit, then approve") : c === "r" ? "r <note> send it back to its author to revise" : "3 allow similar (1 h)")).join(" · ");
  return [`\u0002 HELD FOR YOU · ${plain(rv.id)} · from the host's own record`, ...rows, `\u0002 type ${offer}: decided on the host, never by the Doorman`].join("\n");
}
// Shown after the owner edited an item: the original and the edited version side by side in the conversation (both stay in the archive).
export function editedBlock(id, original, edited, width) {
  const w = Math.max(10, width), rows = (t) => wrapText(plain(t).replace(/\r/g, ""), w - 3).map((r) => `\u0001┃ ${r}`);
  return [`\u0002 EDITED BY YOU · ${plain(id)} · not approved yet; the host re-checks it first`, `\u0001┃ ── original ──`, ...rows(original), `\u0001┃ ── your edited version ──`, ...rows(edited)].join("\n");
}
// After a decision the owner must still see WHAT was decided and WHERE the request went (owner feedback: once approved, the request vanished):
// what a decided request was, in a few lines, from the integration's own text (line 1 kind, line 2 "from … → …", then the body).
export function requestSummary(text) {
  const lines = plain(text).split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const kind = lines[0] || "request", from = /^from /.test(lines[1] || "") ? lines[1] : "";
  const rest = lines.slice(from ? 2 : 1), cut = rest.findIndex((l) => /^-{3}/.test(l)); // a "--- the deliverable ---" part is not summarised
  const body = (cut < 0 ? rest : rest.slice(0, cut)).filter(Boolean);
  return { kind, from, body };
}
export const VERBS = { "1": "APPROVED", "2": "DENIED", "3": "ALLOWED SIMILAR (1 h)", "1e": "APPROVED (EDITED BY YOU)", "r": "SENT BACK WITH YOUR NOTE", "a": "ANSWERED" };
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
// The record that goes into the conversation once a decision is made: what it was, so it stays readable after the long request scrolls away.
export function decisionBlock(d, width, maxBody = 6) {
  const w = Math.max(10, width), s = d.sum, more = s.body.length > maxBody;
  const rows = [...(d.note ? [`${d.verb === "DENIED" ? "your reason" : d.verb === "ANSWERED" ? "your answer" : "your note"}: ${d.note}`] : []), s.kind + (s.from ? ` · ${s.from}` : ""), ...s.body.slice(0, maxBody).map((l) => clip(l, 400)), ...(more ? [`… ${s.body.length - maxBody} more lines (the full request is above: PgUp / Home)`] : [])];
  return [`\u0002 ${d.ok === false ? "✗ NOT DECIDED" : d.verb} · ${plain(d.id)} · ${hhmm(d.at)}${d.via ? ` · ${d.via}` : ""} · what it was:`, ...rows.flatMap((r) => wrapText(plain(r), w - 3).map((x) => `\u0001┃ ${x}`))].join("\n");
}
// The two pinned rows under the conversation while nothing is waiting: the last decision and where that request is now.
export function decidedRows(d) {
  if (!d) return [];
  const s = d.sum, head = `${d.ok === false ? "✗ NOT DECIDED" : `${d.verb === "DENIED" ? "✗" : d.verb === "DECIDED ELSEWHERE" || d.verb === "NO LONGER WAITING" ? "•" : d.verb === VERBS.r ? "↩" : "✓"} ${d.verb}`} ${hhmm(d.at)} · ${s.kind}${s.from ? ` · ${s.from}` : ""}${s.body[0] ? ` · ${s.body[0]}` : ""}`;
  return [head, `${d.done ? "📍 now:" : "⏳ now:"} ${d.track || (d.ok === false ? d.result : "waiting for the host to act on it…")}`];
}

// What a typed line does while a review item may be showing. rv = the item on screen ({id, choices, shownAt}), cur = the integration's
// current item now (or null), gone = { id, at } of the item that just went away. -> { kind: "chat" } | { kind: "refuse", note } | { kind: "decide", id, choice }
export function classifyLine(line, { rv, cur, gone, now = Date.now() } = {}) {
  const cl = choiceLine(line);
  if (!cl) return { kind: "ignore" };
  const k = cl.k, note = cl.note;
  if (!rv && cur) return { kind: "refuse", note: "a request just arrived: read it, then type your choice" }; // never a number typed before it was on screen
  if (rv && cur && cur.id === rv.id) {
    if (now - rv.shownAt < REVIEW_EARLY_MS) return { kind: "refuse", note: `that request appeared less than ${REVIEW_EARLY_MS / 1000} s ago: read it, then type your choice again` };
    if (!rv.choices.includes(k)) return { kind: "refuse", note: `${k} isn't offered for this request (${rv.choices.join(", ")})` };
    if (k === "r" && !note) return { kind: "refuse", note: "type r followed by your note, e.g. r use plainer words; nothing was sent" };
    if (k === "a" && !note) return { kind: "refuse", note: "type a followed by your answer, e.g. a use G's own browser profile; nothing was sent" };
    if (k === "a" && cl.bad) return { kind: "refuse", note: "your answer has control or invisible formatting characters; type it again as plain text. Nothing was sent" };
    if (note && k === "2" && !rv.reason) return { kind: "refuse", note: "this request can't carry a reason: type 2 alone to deny it" };
    if (note.length > NOTE_MAX) return { kind: "refuse", note: `your ${k === "r" ? "note" : k === "a" ? "answer" : "reason"} is ${note.length} characters; at most ${NOTE_MAX}. Nothing was sent` };
    return note ? { kind: "decide", id: rv.id, choice: k, note } : { kind: "decide", id: rv.id, choice: k };
  }
  if (rv && cur) return { kind: "refuse", note: "a different request is now waiting: read it first, then type your choice" };
  if (rv && !cur) return { kind: "refuse", note: `request ${plain(rv.id)} is no longer waiting (decided elsewhere or expired); nothing was sent` };
  if (gone && now - gone.at < REVIEW_STALE_MS) return { kind: "refuse", note: `request ${plain(gone.id)} is no longer waiting (already decided or expired); nothing was sent` };
  return { kind: "ignore" }; // nothing held: nothing to decide (the window never forwards anything to the Doorman)
}

// Keys from the terminal, as a persistent parser (an escape sequence may arrive split across chunks). Returns events.
export class KeyParser {
  constructor() { this.st = 0; this.seq = ""; this.paste = null; }
  feed(chunk) {
    const ev = [];
    if (this.paste !== null) { // bracketed paste: literal text up to the end marker, never keys (a paste can't press Enter or scroll)
      if (chunk.includes("\x03")) { this.paste = null; return [{ k: "quit" }]; } // an abort always works
      this.paste += chunk; const i = this.paste.indexOf("\x1b[201~");
      if (i < 0) { if (this.paste.length > 20000) this.paste = this.paste.slice(0, 19900) + this.paste.slice(-10); return ev; } // over the cap: the middle is dropped, the end (maybe half the end marker) is kept
      const text = this.paste.slice(0, i), rest = this.paste.slice(i + 6); this.paste = null;
      ev.push({ k: "paste", text }); return ev.concat(this.feed(rest));
    }
    for (let n = 0; n < chunk.length; n++) {
      const c = chunk[n];
      if (c === "\x03" || c === "\x04") { this.st = 0; this.seq = ""; ev.push({ k: "quit" }); continue; } // quit always works, even after a stray ESC
      if (this.st === 1 && c !== "[" && c !== "O") this.st = 0; // a stray ESC doesn't swallow the next key
      if (this.st === 0) { if (c === "\x1b") { this.st = 1; this.seq = ""; } else if (c === "\r" || c === "\n") ev.push({ k: "enter" }); else if (c === "\x7f" || c === "\b") ev.push({ k: "backspace" }); else if (c === "\t") ev.push({ k: "char", c }); else if (c >= " ") ev.push({ k: "char", c }); continue; }
      if (this.st === 1) { this.st = c === "[" ? 2 : 3; continue; }
      if (this.st === 3) { this.st = 0; if (c === "H") ev.push({ k: "home" }); else if (c === "F") ev.push({ k: "end" }); continue; } // SS3: arrows etc. ignored
      this.seq += c; // CSI: parameters until a final byte @-~
      if (/[@-~]/.test(c)) {
        const q = this.seq; this.st = 0; this.seq = "";
        if (q === "200~") { this.paste = ""; return ev.concat(this.feed(chunk.slice(n + 1))); }
        const mouse = q.match(/^<(\d+);\d+;\d+[Mm]$/);
        if (mouse) { const b = Number(mouse[1]); if (q.endsWith("M") && (b & 64)) ev.push({ k: (b & 1) ? "wheeldown" : "wheelup" }); continue; }
        if (q === "5~") ev.push({ k: "pgup" }); else if (q === "6~") ev.push({ k: "pgdn" });
        else if (q === "1;2A") ev.push({ k: "sup" }); else if (q === "1;2B") ev.push({ k: "sdown" });
        else if (q === "H" || q === "1~" || q === "7~") ev.push({ k: "home" }); else if (q === "F" || q === "4~" || q === "8~") ev.push({ k: "end" });
      }
    }
    return ev;
  }
}


// ---- the folded view (owner: "it should mostly look like a normal agent window … remove the stuff that's not important, just the requests and
// the results, and the approvals"): calm text on the terminal's own background. Requests to the Doorman are soft light-blue blocks, results are
// plain text, decisions are one line each (updated in place as the request moves on), and what waits for the owner sits in a panel at the bottom,
// right by the input line, the only place that uses red. Tool calls, tool results, the host card and transport labels are not shown (Tab: full log).
// Line markers (stripped from every outside string by plain(), so no Doorman or sandbox text can take a style): \u0003 request block,
// \u0004 result text, \u0005 dim label, \u0006 decision line.
const MDX = (s) => s.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/`([^`\n]+)`/g, "$1").replace(/^#{1,6}\s+/, "");
// The lines that carry meaning: transport labels ("[… via the drop-box …]", "[sandboxed: …] (…)"), quote bars and the host card are dropped.
export function meaningful(t) {
  return String(t ?? "").replace(/\[your host card[\s\S]*?\[end of host card\]\s*/g, "").split("\n")
    .map((l) => MDX(l.replace(/^[\s│|>]*(?:🐳[│ ]*)*/u, "").trim()))
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l) && !/^\[[^\]]*\]\s*\(.*\)?$/.test(l) && !/^\(.*\)$/.test(l) && !/^Reply \(optional\)/.test(l));
}
// folded: at most `max` characters of the text (whole lines first), the rest behind Tab
const block = (mk, lines, max) => { const out = []; let n = 0; for (const l of lines) { if (n >= max) break; const room = max - n; out.push(l.length > room ? clip(l, room) : l); n += l.length; } if (n > max || out.length < lines.length) out[out.length - 1] = out[out.length - 1].replace(/…?$/, "…"); return out.map((l) => mk + l).join("\n"); };
// One RPC event -> its folded display (or null).
export function foldedRender(ev) {
  if (!ev || ev.type !== "message_end" || !ev.message) return null;
  const m = ev.message;
  if (m.role === "toolResult") return null;
  if (m.role !== "assistant") {
    const raw = plain(textOf(m)), ls = meaningful(raw);
    if (!ls.length) return null;
    const note = m.role === "custom" && /^\s*\[[A-Za-z0-9_-]{1,20}\]\s/.test(raw); // a short "[host] request …: done" note injected by the integration (never a typed user line)
    // a host receipt ("[host] request …: failed"): labelled as the host's, never drawn like the Doorman's own words (Doorview)
    if (note) { const src = (/^\s*\[([A-Za-z0-9_-]{1,20})\]/.exec(raw) || [, "host"])[1]; return `\u0005⚙ from ${src} (the host, not the Doorman)\n` + block("\u0005", ls.map((l, k) => (k ? l : `📍 ${l.replace(/^\[[^\]]*\]\s*/, "")}`)), 200); }
    const who = /^\[([^\]\n]{1,60})\]\s*/.exec(ls[0]), body = who ? [ls[0].slice(who[0].length), ...ls.slice(1)].filter(Boolean) : ls;
    return `\u0005${who ? `from ${who[1]}` : "request"}\n` + block("\u0003", body, 280);
  }
  const calls = (m.content || []).filter((c) => c?.type === "toolCall"), out = [];
  for (const c of calls) {
    const a = c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments) ? c.arguments : {};
    const txt = typeof a.text === "string" ? a.text : typeof a.message === "string" ? a.message : "";
    if (!txt) continue; // reading files, looking things up: not shown
    const to = a.to ?? a.for ?? "";
    out.push(`\u0005Doorman → ${clip(plain(String(Array.isArray(to) ? to.join(", ") : to)) || plain(String(c.name)).replace(/^[a-z0-9]+_/, ""), 60)}`, block("\u0004", meaningful(plain(txt)), 240));
  }
  const t = plain(textOf(m)).trim();
  if (t && !out.length) out.push(block("\u0005", ["Doorman: " + meaningful(t).join(" ")], 150)); // its own words only when it sent nothing (else they repeat the reply)
  if (m.stopReason === "error") out.push(`\u0005⚠ ${clip(plain(m.errorMessage), 300)}`);
  return out.length ? out.join("\n") : null;
}
const VERB_WORDS = { ANSWERED: "Answered", APPROVED: "Approved", DENIED: "Denied", "ALLOWED SIMILAR (1 h)": "Approved, and similar ones for 1 h", "APPROVED (EDITED BY YOU)": "Approved your edit", "SENT BACK WITH YOUR NOTE": "Sent back", "DECIDED ELSEWHERE": "Decided elsewhere", "NO LONGER WAITING": "No longer waiting", ANSWERED: "Answered" };
// What an item is, in a few words: the integration's own title, else its kind and route.
export function itemTitle(rv) { if (rv?.title) return plain(rv.title).replace(/\s+/g, " ").trim(); const s = requestSummary(rv?.text ?? ""); return `${s.kind}${s.from ? ` · ${s.from.replace(/^from /, "")}` : ""}`; }
// A decided request in the history: one line, rewritten in place as the host reports where it went.
export function decisionLine(d) {
  const sym = d.ok === false ? "✗" : d.verb === "DENIED" ? "✗" : d.verb === "DECIDED ELSEWHERE" || d.verb === "NO LONGER WAITING" ? "•" : d.verb === "SENT BACK WITH YOUR NOTE" ? "↩" : "✓";
  const first = d.sum?.body?.[0] ? ` "${clip(d.sum.body[0], 90)}"` : "";
  const now = d.ok === false ? d.result : d.track || "the host is acting on it…";
  return `\u0006${sym} ${hhmm(d.at)}  ${d.ok === false ? "Not decided" : VERB_WORDS[d.verb] || d.verb}  ·  ${plain(d.title || "")}${first}${d.note ? `  ·  your note: ${plain(d.note)}` : ""}\n\u0005   ${d.done ? "📍" : "⏳"} ${plain(now)}`;
}
// The decision panel at the bottom while something waits: title, who and when, the request (its first rows unless opened with Space), choices.
export function panelRows(rv, width, { maxBody = 15, offset = 0 } = {}) {
  const w = Math.max(10, width) - 2, s = requestSummary(rv.text), lines = plain(rv.text).replace(/\r/g, "").split("\n");
  let body = lines.slice(s.from ? 2 : 1); while (body.length && !body[0].trim()) body.shift();
  if (rv.edit) body = ["── your edited version ──", ...plain(rv.edit.text).split("\n"), "", "── original ──", ...plain(rv.edit.original).split("\n")];
  const wrapped = body.flatMap((l) => wrapText(MDX(l), w - 2)), total = wrapped.length, off = Math.max(0, Math.min(offset, Math.max(0, total - maxBody)));
  const shown = wrapped.slice(off, off + maxBody), more = total - off - shown.length;
  const choice = { 1: rv.edit ? "1 Approve your edit" : "1 Approve", 2: rv.answer ? "2 Decline to answer" : "2 Deny", 3: "3 Approve + similar for 1 h", e: rv.edit ? "e Edit again" : "e Edit", r: "r Send back", a: "a Answer" };
  const extra = [rv.reason && rv.choices.includes("2") && "2 <reason> tells them why", rv.choices.includes("r") && "r <note> adds your note", rv.choices.includes("a") && "a <your answer>", (total > maxBody || off > 0) && (maxBody >= total ? "" : "Space: read all · PgUp/PgDn")].filter(Boolean);
  const rowsOut = [
    { s: "title", t: ` Needs your decision: ${itemTitle(rv)}` },
    { s: "meta", t: ` ${s.from ? s.from.replace(/^from /, "from ") + " · " : ""}${plain(rv.id)} · waiting since ${hhmm(rv.shownAt || Date.now())}` },
    ...(off > 0 ? [{ s: "more", t: `  ↑ ${off} lines above` }] : []),
    ...shown.map((t) => ({ s: "body", t: ` ${t}` })),
    ...(more > 0 ? [{ s: "more", t: `  … ${more} more lines (Space: read all)` }] : []),
    { s: "choices", t: ` ${rv.choices.map((c) => choice[c] || c).join("    ")}` },
    ...(extra.length ? [{ s: "meta", t: ` ${extra.join(" · ")}` }] : []),
  ];
  rowsOut.seen = { from: off, to: off + shown.length, total }; // which body rows are on screen (for the read-it-all gate)
  return rowsOut;
}
// Fit the panel into `room` rows: drop the help rows first, then body rows from the end (with a "more" row), never the title or the choices.
export function fitPanel(rows, room) {
  if (rows.length <= room) return rows;
  let r = rows.filter((x) => x.s !== "meta" || x === rows[1]); if (r.length > room) r = r.filter((x) => x.s !== "meta");
  while (r.length > room && r.some((x) => x.s === "body")) { const i = r.map((x) => x.s).lastIndexOf("body"); r.splice(i, 1); }
  r = r.filter((x, i) => !(x.s === "more" && r[i - 1]?.s === "more"));
  if (r.length > room) r = r.filter((x) => x.s === "title" || x.s === "choices");
  r.seen = { ...rows.seen, to: rows.seen.from + r.filter((x) => x.s === "body").length };
  return r;
}

async function view(name, write) {
  const d = stateDir(name), f = path.join(d, "events.jsonl");
  const label = process.env.PI_DOORMAN_LABEL || name, red = rgbOf(reviewHex());
  const sbF = new Scrollback(), sbC = new Scrollback(); let full = false; const sbv = () => (full ? sbF : sbC);
  let buf = "", started = false, editing = false, info = "", notice = null, expanded = false, panelOff = 0;
  let review = null, rv = null, gone = null, decidedId = "", decided = null;
  if (process.env.PI_DOORMAN_REVIEW_MODULE) { try { const mod = await import(pathToFileURL(process.env.PI_DOORMAN_REVIEW_MODULE).href); review = await mod.default(name); } catch (e) { process.stderr.write(`review module failed: ${e.message}\n`); } }
  const readCur = () => { try { const c = review?.current(); return c && typeof c.id === "string" && typeof c.text === "string" && Array.isArray(c.choices) ? { id: c.id.slice(0, 80), text: c.text, title: typeof c.title === "string" ? c.title.slice(0, 200) : "", choices: c.choices.filter((x) => ["1", "2", "3", "e", "r", "a"].includes(x)), reason: c.reason === true, answer: c.answer === true } : null; } catch { return null; } };
  const W = () => Math.max(20, process.stdout.columns || 80), Hh = () => Math.max(8, process.stdout.rows || 24), TOP = () => (info ? 3 : 2);
  const panel = () => (rv && write !== undefined ? panelRows(rv, W(), { maxBody: expanded ? Math.max(3, Hh() - TOP() - 8) : Math.max(3, Math.min(15, Math.floor(Hh() * 0.45))), offset: panelOff }) : []);
  const panelFit = () => { const p = panel(); if (!p.length) return p; const f = fitPanel(p, Math.max(2, Hh() - TOP() - 3)); if (rv) { const sn = f.seen; if (sn.from <= (rv.readTo ?? 0)) rv.readTo = Math.max(rv.readTo ?? 0, sn.to); rv.readAll = (rv.readTo ?? 0) >= sn.total; } return f; };
  const VH = (pn = panelFit().length) => Math.max(1, Hh() - TOP() + 1 - pn - 2 - (pn ? 1 : 0));
  const P = (x) => process.stdout.write(x);
  let pasteDirty = false; // (J385) the box holds pasted text that had control or formatting characters
  const hostRow = (t) => `\u0002 ${plain(t)}`;
  const say = (t) => { notice = { t: plain(t), at: Date.now() }; sbF.add(hostRow(t), W()); };
  const pad = (r, w) => r + " ".repeat(Math.max(0, w - cells(r)));
  const styled = (r, w) => {
    const c = r[0], x = r.slice(1);
    if (c === "\u0003") return `\x1b[48;2;226;236;250m\x1b[38;2;25;35;55m${pad(" " + x, w)}\x1b[0m`;   // a request: soft light blue, like a prompt
    if (c === "\u0004") return ` ${x}`;                                                                 // a result: plain text
    if (c === "\u0005") return `\x1b[2m ${x}\x1b[0m`;                                                  // a label / where it went: dim
    if (c === "\u0006") return `\x1b[1m ${x.replace(/^([✓✗↩•])/, (m) => (m === "✓" ? "\x1b[38;2;30;130;60m✓\x1b[39m" : m === "✗" ? "\x1b[38;2;150;150;150m✗\x1b[39m" : m))}\x1b[0m`;
    if (c === "\u0002") return `\x1b[2m${x}\x1b[0m`;
    if (c === "\u0001") return `\x1b[48;2;242;242;242m${pad(x, w)}\x1b[0m`;
    return r;
  };
  const paintPanelRow = (p, w) => {
    const t = clipCells(p.t, w);
    if (p.s === "title") return `\x1b[48;2;${red}m\x1b[38;2;255;255;255m\x1b[1m${pad(t, w)}\x1b[0m`;            // the one red thing on screen
    if (p.s === "body") return `\x1b[38;2;${red}m▌\x1b[0m\x1b[48;2;246;246;246m\x1b[38;2;20;20;20m${pad(clipCells(t, w - 1), w - 1)}\x1b[0m`;
    if (p.s === "choices") return `\x1b[1m${pad(t, w)}\x1b[0m`;
    return `\x1b[2m${pad(t, w)}\x1b[0m`;
  };
  const paint = () => {
    if (!started || editing) return;
    const w = W(), pn = panelFit(), vh = VH(pn.length), rows = sbv().window(w - 1, vh);
    let o = `\x1b[?25l\x1b[1;1H\x1b[2K\x1b[1m 🚪 ${clipCells(label, 40)}\x1b[0m\x1b[2m · requests, results and your decisions · ${full ? "full log (Tab: folded)" : "Tab: full log"} · ${write ? "type only your decision" : "read-only"}\x1b[0m\x1b]2;🚪 ${label}\x07`;
    if (info) o += `\x1b[2;1H\x1b[2K\x1b[2m${clipCells(" " + info, w)}\x1b[0m`;
    for (let i = 0; i < vh; i++) o += `\x1b[${TOP() + i};1H\x1b[2K${styled(rows[i - (vh - rows.length)] ?? "", w)}`;
    let y = TOP() + vh;
    if (pn.length) { o += `\x1b[${y++};1H\x1b[2K`; for (const p of pn) o += `\x1b[${y++};1H\x1b[2K${paintPanelRow(p, w)}`; }
    const st = notice && Date.now() - notice.at < 8000 ? `\x1b[1m ${clipCells(notice.t, w - 2)}\x1b[0m` : `\x1b[2m ${clipCells(sbv().offset > 0 ? statusText(sbv().offset, sbv().unseen) : rv ? (write ? "read the request, then type your choice and Enter" : "read-only: decide elsewhere") : "nothing waiting for you", w - 2)}\x1b[0m`;
    o += `\x1b[${Hh() - 1};1H\x1b[2K${st}`;
    const pre = rv ? "decide> " : "> ", inputRow = write ? pre + tailCells(plain(buf), Math.max(4, w - 2 - cells(pre))) : "";
    o += `\x1b[${Hh()};1H\x1b[2K${rv && write ? `\x1b[1m\x1b[38;2;${red}m${pre}\x1b[0m${inputRow.slice(pre.length)}` : `\x1b[2m${inputRow}\x1b[0m`}\x1b[?25h`;
    P(o);
  };
  const refresh = () => { try { const t = plain(String(review?.info?.() ?? "")).replace(/\s+/g, " ").trim().slice(0, 400); if (t !== info) { info = t; P("\x1b[2J"); } } catch { /* */ } pollReview(); pollTrack(); };
  const waitLine = (item) => `\u0005⏸ ${hhmm(Date.now())}  waiting for you: ${plain(itemTitle(item))}`;
  const pollReview = () => {
    if (!review) return;
    const cur = readCur();
    if (cur && rv && rv.id !== cur.id && rv.id !== decidedId) lost(rv);
    if (cur && (!rv || rv.id !== cur.id)) {
      if (buf) { buf = ""; say("what you had typed was cleared: a new request arrived; read it, then type your choice"); }
      rv = { ...cur, shownAt: Date.now() }; expanded = false; panelOff = 0;
      rv.line = sbC.add(waitLine(rv), W() - 1); sbC.live(); sbF.add(reviewBlock(rv, W() - 1), W() - 1, 400000); sbF.live(); P("\x1b[2J"); paint();
    } else if (!cur && rv) { gone = { id: rv.id, at: Date.now() }; buf = ""; if (rv.id !== decidedId) lost(rv); rv = null; expanded = false; P("\x1b[2J"); paint(); }
  };
  const record = (dd) => { if (dd.line >= 0) sbC.set(dd.line, decisionLine(dd), W() - 1); else dd.line = sbC.add(decisionLine(dd), W() - 1); };
  function lost(item) {
    decided = { id: item.id, verb: "DECIDED ELSEWHERE", via: "", at: Date.now(), sum: requestSummary(item.text), title: itemTitle(item), track: "", done: false, line: item.line ?? -1 };
    record(decided); sbF.add(hostRow(`request ${item.id} is no longer waiting (decided elsewhere or expired)`), W() - 1); sbF.add(decisionBlock(decided, W() - 1), W() - 1, 400000); trackAt = 0;
  }
  let trackAt = 0;
  const pollTrack = () => {
    if (!decided || decided.done || decided.ok === false || !review?.track) return;
    const now = Date.now(); if (now - trackAt < 1500) return; trackAt = now;
    if (now - decided.at > 30 * 60e3) { decided.done = true; decided.track = `${decided.track || "no news from the host"} (stopped following after 30 min)`; record(decided); return paint(); }
    let t = null; try { t = review.track(decided.id); } catch { return; }
    if (!t || typeof t.text !== "string") return;
    if (t.state === "gone" && now - decided.at < 60e3) t = { state: "pending", done: false, text: decided.verb === "DECIDED ELSEWHERE" ? "checking what happened to it…" : "the host is acting on it…" };
    else if (t.state === "gone" && decided.verb === "DECIDED ELSEWHERE") decided.verb = "NO LONGER WAITING";
    const text = plain(t.text).replace(/\s+/g, " ").trim().slice(0, 400);
    if (decided.verb === "DECIDED ELSEWHERE" && ["approved", "denied", "returned"].includes(t.state)) decided.verb = t.state === "approved" ? "APPROVED" : t.state === "returned" ? VERBS.r : "DENIED";
    if (text && text !== decided.track) { decided.track = text; sbF.add(hostRow(`${t.done ? "📍" : "⏳"} ${decided.id}: ${text}`), W() - 1); }
    if (t.done) decided.done = true;
    record(decided); paint();
  };
  let pos = 0;
  try { pos = Math.max(0, fs.statSync(f).size - 400000); } catch { /* none yet */ }
  let rbuf = "", skipFirst = pos > 0;
  const pump = () => {
    let fd; try { fd = fs.openSync(f, "r"); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size; if (size < pos) { pos = 0; skipFirst = false; }
      const b = Buffer.alloc(Math.min(size - pos, 1 << 20)); const n = fs.readSync(fd, b, 0, b.length, pos); pos += n; rbuf += b.toString("utf8", 0, n);
      let i; while ((i = rbuf.indexOf("\n")) >= 0) { const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1); if (skipFirst) { skipFirst = false; continue; } try { const ev = JSON.parse(line), r = render(ev), c = foldedRender(ev); if (r) sbF.add(plain(r), W() - 1); if (c) sbC.add("\n" + c, W() - 1); } catch { /* */ } }
    } finally { fs.closeSync(fd); }
  };
  const mouse = (on) => P(`\x1b[?1000${on ? "h" : "l"}\x1b[?1006${on ? "h" : "l"}\x1b[?2004${on ? "h" : "l"}`);
  const quit = () => { mouse(false); P("\x1b[?25h\x1b[2J\x1b[H"); process.exit(0); };
  process.on("SIGTERM", quit); process.on("SIGHUP", quit); process.on("SIGINT", quit);
  process.on("exit", () => { try { mouse(false); } catch { /* */ } }); process.on("uncaughtException", (e) => { try { mouse(false); P("\x1b[?25h"); } catch { /* */ } console.error(e); process.exit(1); });
  P("\x1b[2J"); mouse(true);
  pump();
  sbF.add(write ? "Full log of the Doorman's conversation (Tab: back to the folded view). The only thing you can type in this window is a decision for a held request; nothing typed here reaches the Doorman." : "Archive, read-only. Nothing you do here reaches the Doorman.", W() - 1);
  started = true; refresh(); paint();
  setInterval(() => { pump(); refresh(); paint(); }, 500);
  process.stdout.on("resize", () => { P("\x1b[2J"); paint(); });
  const send = () => {
    if (!review) { say("nothing to decide; this window only takes decisions"); buf = ""; return paint(); }
    pollReview();
    // (AnswerReview) a paste is cleaned as it arrives, so an answer that came with control or formatting characters is refused here too
    const cur = readCur(), c0 = classifyLine(buf, { rv, cur, gone }), dirty = pasteDirty; pasteDirty = false;
    const c = c0.kind === "decide" && c0.choice === "a" && dirty ? { kind: "refuse", note: "your answer had control or invisible formatting characters (pasted); type it again as plain text. Nothing was sent" } : c0;
    if (c.kind === "ignore") { say(rv ? `only a decision can be typed here: ${rv.choices.join(" / ")}` : "nothing is waiting for a decision"); buf = ""; return paint(); }
    if (c.kind === "refuse") { say(c.note); buf = ""; return paint(); }
    if (c.choice === "e") return startEdit();
    // what approves anything needs the whole request to have been on screen (LayoutReview): a long one is opened with Space and read to the end
    if ((c.choice === "1" || c.choice === "3") && rv && !rv.readAll) { say("read the whole request first: press Space, then PgDn to its end; nothing was decided"); buf = ""; return paint(); }
    const id = c.id, edited = c.choice === "1" && rv.edit ? rv.edit.text : undefined, note = c.note || ""; buf = ""; decidedId = id;
    const dd = decided = { id, verb: VERBS[c.choice === "1" && edited !== undefined ? "1e" : c.choice] || c.choice, via: "", at: Date.now(), sum: requestSummary(rv?.text ?? ""), title: itemTitle(rv), track: "", done: false, note, line: rv.line ?? -1 };
    trackAt = 0; record(dd); say(`deciding ${id} on the host…`); paint();
    const settle = (ok, text) => {
      if (!ok) { dd.ok = false; dd.result = `the host refused: ${text}`; say(`✗ not decided: ${text}`); }
      record(dd); sbF.add(decisionBlock(dd, W() - 1), W() - 1, 400000); if (text || !ok) sbF.add(hostRow(`${ok ? "✓" : "✗"} ${text || "no answer"}`), W() - 1); if (ok) notice = null;
      sbC.live(); sbF.live(); paint();
    };
    Promise.resolve().then(() => review.decide(id, c.choice, edited, note || undefined)).then((r) => settle(!!r?.ok, plain(String(r?.text ?? "")).slice(0, 500)), (e) => settle(false, plain(String(e?.message ?? e)).slice(0, 300)));
  };
  const HINT_MARK = "# ----- pi-doorman: everything below this line is ignored -----";
  const startEdit = () => {
    buf = ""; const id = rv.id; let src = null;
    try { src = review.edit?.(id); } catch (e) { say(`✗ can't edit: ${plain(String(e?.message ?? e)).slice(0, 200)}`); return paint(); }
    if (!src || typeof src.text !== "string") { say("this kind of request can't be edited; approve or deny it"); return paint(); }
    const original = rv.edit ? rv.edit.text : src.text, dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doorman-edit-")), file = path.join(dir, "edit.txt");
    fs.writeFileSync(file, original + (src.hint ? `\n\n${HINT_MARK}\n${String(src.hint).replace(/\n/g, " ")}\n` : ""), { mode: 0o600 });
    editing = true; mouse(false); P("\x1b[?25h\x1b[2J\x1b[H"); if (process.stdin.isTTY) process.stdin.setRawMode(false);
    const ed = (process.env.VISUAL || process.env.EDITOR || "nano").split(/\s+/).filter(Boolean);
    try { spawnSync(ed[0], [...ed.slice(1), file], { stdio: "inherit" }); } catch { /* unchanged */ }
    if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.resume(); P("\x1b[2J"); mouse(true); editing = false;
    let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    { const k = text.indexOf(HINT_MARK); if (k >= 0) text = text.slice(0, k); } text = text.replace(/\r/g, "").replace(/\s+$/, "");
    text = plain(text.replace(/\t/g, " ")).replace(/\n{3,}/g, "\n\n").slice(0, 20000);
    if (!text.trim() || text === original) { say(text === original ? "no change: nothing edited" : "empty: edit cancelled"); return paint(); }
    rv.edit = { text, original: rv.edit?.original ?? src.text }; rv.choices = ["1", "2", "e"]; rv.shownAt = Date.now(); panelOff = 0; rv.readTo = 0; rv.readAll = false; // the 2 s rule starts again
    sbF.add(editedBlock(id, rv.edit.original, text, W() - 1), W() - 1, 400000); say("your edit is shown in the panel; type 1 to approve it"); P("\x1b[2J"); paint();
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8"); process.stdin.resume();
  const keys = new KeyParser(), page = () => Math.max(1, VH() - 1);
  const panelPage = () => Math.max(1, (panelFit().seen?.to ?? 1) - (panelFit().seen?.from ?? 0) - 1);
  const scroll = (n, pg) => { if (rv && expanded) panelOff = Math.max(0, panelOff - (pg ? Math.sign(n) * panelPage() : n)); else sbv().scrollBy(n, W() - 1, VH()); };
  process.stdin.on("data", (chunk) => {
    for (const e of keys.feed(chunk)) {
      if (e.k === "quit") quit();
      else if (e.k === "pgup") scroll(page(), true); else if (e.k === "pgdn") scroll(-page(), true);
      else if (e.k === "sup" || e.k === "wheelup") scroll(e.k === "sup" ? 1 : 3); else if (e.k === "sdown" || e.k === "wheeldown") scroll(e.k === "sdown" ? -1 : -3);
      else if (e.k === "home") sbv().top(W() - 1, VH()); else if (e.k === "end") { sbv().live(); panelOff = 0; }
      else if (e.k === "char" && e.c === "\t") { full = !full; P("\x1b[2J"); }
      else if (e.k === "char" && e.c === " " && !buf && rv) { expanded = !expanded; panelOff = 0; P("\x1b[2J"); }
      else if (!write) continue;
      else if (e.k === "enter") send();
      else if (e.k === "backspace") { buf = [...SEG.segment(buf)].slice(0, -1).map((x) => x.segment).join(""); if (!buf) pasteDirty = false; } // (an emptied box forgets the paste at once, AnswerReview)
      else if (e.k === "char") buf += e.c;
      else if (e.k === "paste") { if (CTRL.test(String(e.text).replace(/[\t\n\r]/g, " "))) pasteDirty = true; buf += plain(e.text).replace(/\s+/g, " "); }
    }
    if (!buf) pasteDirty = false; // an emptied box forgets what was pasted into it
    paint();
  });
}

export function runView(cmd, a, b) {
  if (cmd === "log" && a) log(a);
  else if (cmd === "view" && a) view(a, b === "--write");
  else { console.error("usage: pi-doorman log NAME | view NAME [--write]"); process.exit(2); }
}
