// The developer / observer window and the event log. The Doorman's Pi runs in RPC mode; its stdout (JSON events) is piped through
// `log`, and its stdin is a FIFO that only `view --write` feeds.
//   pi-doorman log NAME            stdin events -> events.jsonl (+ status.json: state, last question/answer)
//   pi-doorman view NAME [--write] live render; with --write (developer mode) a prompt line whose text is sent to the Doorman
//                                  marked as the owner's own, never as a sandbox request
// Config by environment (a host integration sets these): PI_DOORMAN_STATE (state root), PI_DOORMAN_MARKER, PI_DOORMAN_LABEL,
// PI_DOORMAN_COLOR (hex, default 3b6ea5), PI_DOORMAN_UNIT_PREFIX (systemd user unit name prefix, default pi-doorman-).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

export const MARKER = process.env.PI_DOORMAN_MARKER || "[owner · developer window";
export const stateDir = (name) => path.join(process.env.PI_DOORMAN_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-doorman", "view"), name);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const plain = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("") : String(m?.content ?? ""));

// What the owner typed becomes ONE prompt line for Pi's RPC stdin, opening with the marker. followUp: if the Doorman is
// mid-turn the text waits for it instead of being refused.
export function promptLine(typed) {
  const t = plain(typed).replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!t) return null;
  const message = `${MARKER} · from the owner, typing directly to you; not a sandbox request, no request_id. Answer him in plain text here.]\n${t}`;
  return JSON.stringify({ type: "prompt", message, streamingBehavior: "followUp" }) + "\n";
}

// One RPC event -> a short display line (or null). Shared by the viewer and the status writer's idea of a Q and A.
export function render(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "agent_start") return "── turn ──";
  if (ev.type === "message_end" && ev.message) {
    const m = ev.message, t = plain(textOf(m)).trim();
    if (m.role !== "assistant" && m.role !== "toolResult") return t ? `❓ ${clip(t.replace(/\[your host card[\s\S]*?\[end of host card\]\s*/, "[card] "), 1200)}` : null;
    if (m.role === "assistant") {
      const calls = (m.content || []).filter((c) => c?.type === "toolCall").map((c) => `🔧 ${c.name}(${clip(JSON.stringify(c.arguments ?? {}), 300)})`);
      return [t && `💬 ${t}`, ...calls, m.stopReason === "error" && `⚠ ${clip(m.errorMessage, 200)}`].filter(Boolean).join("\n") || null;
    }
    if (m.role === "toolResult") return `   ↳ ${clip(plain(textOf(m)), 300)}`;
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
export function worldHex() { const c = String(process.env.PI_DOORMAN_COLOR || "").replace(/^#/, ""); return /^[0-9A-Fa-f]{6}$/.test(c) ? c : "3b6ea5"; }
const rgbOf = (h) => { const n = parseInt(h, 16); return `${n >> 16};${(n >> 8) & 255};${n & 255}`; };
// Why typing is unavailable right now ("" = free). write = developer mode.
export function lockReason({ write, unitActive, state, lastQuestion }) {
  if (!write) return "read-only";
  if (!unitActive) return "Doorman offline";
  if (state === "working") return String(lastQuestion || "").startsWith(MARKER) ? "answering you; wait for it" : "busy answering the sandbox's request";
  return "";
}
export function headerText(label, write, lock) {
  return `🚪 ${label} · ${write ? "DEVELOPER MODE" : "OBSERVER (read-only)"}${lock ? ` · 🔒 ${lock}` : " · ✎ typing on"}`;
}
const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const gw = (g) => (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60]/u.test(g) ? 2 : 1);
export const cells = (s) => [...SEG.segment(s)].reduce((n, x) => n + gw(x.segment), 0);
export const clipCells = (s, max) => { let n = 0, o = ""; for (const x of SEG.segment(s)) { const w = gw(x.segment); if (n + w > max) break; n += w; o += x.segment; } return o; };
const tailCells = (s, max) => { const g = [...SEG.segment(s)].map((x) => x.segment); let n = 0, o = ""; for (let i = g.length - 1; i >= 0; i--) { const w = gw(g[i]); if (n + w > max) break; n += w; o = g[i] + o; } return o; };
const unitIsActive = (name) => { try { execFileSync("systemctl", ["--user", "is-active", "--quiet", `${process.env.PI_DOORMAN_UNIT_PREFIX || "pi-doorman-"}${name}`]); return true; } catch { return false; } };

// ---- scrollback (pure, tested): wrapping never cuts a line, the model keeps the conversation and a viewport offset.
export function wrapText(text, width) {
  const w = Math.max(1, width), rows = [];
  for (const line of String(text).split("\n")) {
    let cur = "", n = 0;
    for (const x of SEG.segment(line)) { const g = gw(x.segment); if (n + g > w && cur) { rows.push(cur); cur = ""; n = 0; } cur += x.segment; n += g; }
    rows.push(cur);
  }
  return rows;
}
export class Scrollback {
  constructor(max = 3000) { this.entries = []; this.max = max; this.offset = 0; this.unseen = 0; this.w = 0; this.cache = []; }
  rowsFor(i, width) { return (this.cache[i] ??= wrapText(this.entries[i], width)); }
  all(width) { if (width !== this.w) { this.w = width; this.cache = []; } const r = []; for (let i = 0; i < this.entries.length; i++) r.push(...this.rowsFor(i, width)); return r; }
  add(text, width) { // a new entry: the view stays where it is while scrolled up (and counts what's new)
    const before = this.offset > 0 ? wrapText(text, width).length : 0;
    this.entries.push(String(text)); if (this.entries.length > this.max) { this.entries.shift(); this.cache.shift(); }
    if (this.offset > 0) { this.offset += before; this.unseen++; }
  }
  clamp(width, height) { const total = this.all(width).length; this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - height))); }
  scrollBy(rows, width, height) { this.offset += rows; this.clamp(width, height); if (this.offset === 0) this.unseen = 0; }
  top(width, height) { this.offset = Math.max(0, this.all(width).length - height); }
  live() { this.offset = 0; this.unseen = 0; }
  window(width, height) { this.clamp(width, height); const r = this.all(width), end = r.length - this.offset; return r.slice(Math.max(0, end - height), end); }
}
export const statusText = (offset, unseen) => (offset > 0 ? `↑ scrolled · End for live${unseen ? ` · ${unseen} new` : ""} · PgUp/PgDn, wheel, Home` : "wheel / PgUp / PgDn / Shift+arrows scroll · End = live");

// Keys from the terminal, as a persistent parser (an escape sequence may arrive split across chunks). Returns events.
export class KeyParser {
  constructor() { this.st = 0; this.seq = ""; }
  feed(chunk) {
    const ev = [];
    for (const c of chunk) {
      if (this.st === 0) { if (c === "\x1b") { this.st = 1; this.seq = ""; } else if (c === "\x03" || c === "\x04") ev.push({ k: "quit" }); else if (c === "\r" || c === "\n") ev.push({ k: "enter" }); else if (c === "\x7f" || c === "\b") ev.push({ k: "backspace" }); else if (c >= " ") ev.push({ k: "char", c }); continue; }
      if (this.st === 1) { if (c === "[") this.st = 2; else if (c === "O") this.st = 3; else this.st = 0; continue; }
      if (this.st === 3) { this.st = 0; if (c === "H") ev.push({ k: "home" }); else if (c === "F") ev.push({ k: "end" }); continue; } // SS3: arrows etc. ignored
      this.seq += c; // CSI: parameters until a final byte @-~
      if (/[@-~]/.test(c)) {
        const q = this.seq; this.st = 0; this.seq = "";
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

function view(name, write) {
  const d = stateDir(name), f = path.join(d, "events.jsonl"), fifo = path.join(d, "input.fifo"), sf = path.join(d, "status.json");
  const label = process.env.PI_DOORMAN_LABEL || name, bg = rgbOf(worldHex());
  const W = () => Math.max(10, process.stdout.columns || 80), Hh = () => Math.max(6, process.stdout.rows || 24), VH = () => Hh() - 3; // header, conversation, status line, input
  const P = (s) => process.stdout.write(s);
  const mode = write ? "DEVELOPER MODE" : "OBSERVER (read-only)";
  let lock = "", buf = "", unitOk = true, status = {}, sentAt = 0, seenWorking = false, started = false;
  const sb = new Scrollback();
  const bar = (txt) => { const w = W(); let t = clipCells(` ${txt}`, w); t += " ".repeat(Math.max(0, w - cells(t))); return `\x1b[48;2;${bg}m\x1b[38;2;255;255;255m\x1b[1m${t}\x1b[0m`; };
  const prompt = () => { const pre = lock ? `🔒 (${lock}) ${buf ? "held: " : ""}` : "you> "; return pre + tailCells(plain(buf), Math.max(4, W() - 1 - cells(pre))); };
  // One repaint writes everything: pinned header, the wrapped conversation viewport, a status line, the input line (cursor last).
  const paint = () => {
    if (!started) return;
    const w = W(), rows = sb.window(w, VH()); let o = `\x1b[?25l\x1b[1;1H${bar(headerText(label, write, lock))}\x1b]2;🚪 ${label} · ${mode}${lock ? " 🔒" : ""}\x07`;
    for (let i = 0; i < VH(); i++) o += `\x1b[${2 + i};1H\x1b[2K${rows[i - (VH() - rows.length)] ?? ""}`; // short histories sit at the bottom
    o += `\x1b[${Hh() - 1};1H\x1b[2K\x1b[2m${clipCells(statusText(sb.offset, sb.unseen), w - 1)}\x1b[0m`;
    o += `\x1b[${Hh()};1H\x1b[2K${clipCells(write ? prompt() : "🔒 read-only: ctrl-c to close this window", w - 1)}\x1b[?25h`;
    P(o);
  };
  const out = (s) => { sb.add(plain(String(s)), W()); paint(); }; // everything shown passes plain(): no escape sequence from Doorman or sandbox text reaches the terminal
  const refresh = () => {
    unitOk = unitIsActive(name);
    let st = null; try { st = JSON.parse(fs.readFileSync(sf, "utf8")); } catch { /* */ }
    status = st && typeof st === "object" && !Array.isArray(st) ? st : {};
    if (sentAt) { // a line of mine was just sent: locked until the Doorman has gone busy and idle again (or 90 s)
      if (status.state === "working") seenWorking = true;
      if ((seenWorking && status.state === "idle") || Date.now() - sentAt > 90000) { sentAt = 0; seenWorking = false; }
    }
    let l = !write || !unitOk ? lockReason({ write, unitActive: unitOk }) : status.state !== "idle" && status.state !== "working" ? "status unknown" : sentAt ? "answering you; wait for it" : lockReason({ write, unitActive: unitOk, state: status.state, lastQuestion: status.question });
    if (l !== lock) { const was = lock; lock = l; if (was && !l) out("🔓 typing is on again"); else paint(); }
  };
  // History: the tail of the events log (about 400 KB, from a whole line) is loaded at start, then followed.
  let pos = 0;
  try { pos = Math.max(0, fs.statSync(f).size - 400000); } catch { /* none yet */ }
  let rbuf = "", skipFirst = pos > 0;
  const pump = () => {
    let fd; try { fd = fs.openSync(f, "r"); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size; if (size < pos) { pos = 0; skipFirst = false; }
      const b = Buffer.alloc(Math.min(size - pos, 1 << 20)); const n = fs.readSync(fd, b, 0, b.length, pos); pos += n; rbuf += b.toString("utf8", 0, n);
      let i; while ((i = rbuf.indexOf("\n")) >= 0) { const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1); if (skipFirst) { skipFirst = false; continue; } try { const r = render(JSON.parse(line)); if (r) sb.add(plain(r), W()); } catch { /* */ } }
    } finally { fs.closeSync(fd); }
  };
  const mouse = (on) => P(`\x1b[?1000${on ? "h" : "l"}\x1b[?1006${on ? "h" : "l"}`);
  const quit = () => { mouse(false); P("\x1b[?25h\x1b[2J\x1b[H"); process.exit(0); };
  process.on("SIGTERM", quit); process.on("SIGHUP", quit);
  P("\x1b[2J"); mouse(true);
  pump();
  sb.add(write ? "Developer mode: what you type is marked as yours and reaches only the Doorman. It can't approve or run anything, and nothing you type goes to the sandbox." : "Observer mode: read-only. Nothing you do here reaches the Doorman.", W());
  started = true; refresh(); paint();
  setInterval(() => { pump(); refresh(); paint(); }, 500);
  process.stdout.on("resize", () => { P("\x1b[2J"); paint(); });
  const send = () => {
    const pl = promptLine(buf);
    if (!pl) { buf = ""; return; }
    refresh();
    if (lock) { out(`🔒 not sent (${lock}); your line is held, press Enter again when typing is on`); if (!buf.endsWith(" ")) buf += " "; return; }
    try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, pl); fs.closeSync(fd); sb.live(); out(`🧑 you: ${clip(plain(buf), 300)}`); buf = ""; sentAt = Date.now(); seenWorking = false; refresh(); }
    catch (e) { out(`🔒 not sent: the Doorman's input isn't open (${e.code || e.message}); line held`); }
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8"); process.stdin.resume();
  const keys = new KeyParser(), page = () => Math.max(1, VH() - 1);
  process.stdin.on("data", (chunk) => {
    for (const e of keys.feed(chunk)) {
      if (e.k === "quit") quit();
      else if (e.k === "pgup") sb.scrollBy(page(), W(), VH()); else if (e.k === "pgdn") sb.scrollBy(-page(), W(), VH());
      else if (e.k === "sup" || e.k === "wheelup") sb.scrollBy(e.k === "sup" ? 1 : 3, W(), VH()); else if (e.k === "sdown" || e.k === "wheeldown") sb.scrollBy(e.k === "sdown" ? -1 : -3, W(), VH());
      else if (e.k === "home") sb.top(W(), VH()); else if (e.k === "end") sb.live();
      else if (!write) continue; // observer: scrolling only, nothing typed goes anywhere
      else if (e.k === "enter") send();
      else if (e.k === "backspace") buf = [...SEG.segment(buf)].slice(0, -1).map((x) => x.segment).join("");
      else if (e.k === "char") buf += e.c;
    }
    paint();
  });
}

export function runView(cmd, a, b) {
  if (cmd === "log" && a) log(a);
  else if (cmd === "view" && a) view(a, b === "--write");
  else if (cmd === "fifo-line") process.stdout.write(promptLine(a) || "");
  else { console.error("usage: pi-doorman log NAME | view NAME [--write]"); process.exit(2); }
}
