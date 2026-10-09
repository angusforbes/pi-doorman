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
// is possible right now, the live conversation in a scroll region, and an input line that is locked (🔒) with the reason
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

function view(name, write) {
  const d = stateDir(name), f = path.join(d, "events.jsonl"), fifo = path.join(d, "input.fifo"), sf = path.join(d, "status.json");
  const label = process.env.PI_DOORMAN_LABEL || name, bg = rgbOf(worldHex());
  const W = () => process.stdout.columns || 80, Hh = () => process.stdout.rows || 24;
  const P = (s) => process.stdout.write(s);
  const mode = write ? "DEVELOPER MODE" : "OBSERVER (read-only)";
  let lock = "", buf = "", unitOk = true, status = {}, sentAt = 0, seenWorking = false, esc = 0;
  const bar = (txt) => { const w = W(); let t = clipCells(` ${txt}`, w); t += " ".repeat(Math.max(0, w - cells(t))); return `\x1b[48;2;${bg}m\x1b[38;2;255;255;255m\x1b[1m${t}\x1b[0m`; };
  const paintHeader = () => P(`\x1b7\x1b[1;1H${bar(headerText(label, write, lock))}\x1b8\x1b]2;🚪 ${label} · ${mode}${lock ? " 🔒" : ""}\x07`);
  const prompt = () => { const pre = lock ? `🔒 (${lock}) ${buf ? "held: " : ""}` : "you> "; return pre + tailCells(plain(buf), Math.max(4, W() - 1 - cells(pre))); };
  const paintInput = () => P(`\x1b[${Hh()};1H\x1b[2K${clipCells(write ? prompt() : "🔒 read-only: ctrl-c to close this window", W() - 1)}`);
  const setup = () => { P(`\x1b[2J\x1b[2;${Hh() - 1}r`); paintHeader(); P(`\x1b[2;1H`); paintInput(); };
  const out = (s) => { P(`\x1b7\x1b[${Hh() - 1};1H\r\n${plain(String(s)).replace(/\n/g, "\r\n")}\x1b8`); }; // everything shown passes plain(): no escape sequence from Doorman or sandbox text reaches the terminal
  const refresh = () => {
    unitOk = unitIsActive(name);
    let st = null; try { st = JSON.parse(fs.readFileSync(sf, "utf8")); } catch { /* */ }
    status = st && typeof st === "object" && !Array.isArray(st) ? st : {};
    if (sentAt) { // a line of mine was just sent: locked until the Doorman has gone busy and idle again (or 90 s)
      if (status.state === "working") seenWorking = true;
      if ((seenWorking && status.state === "idle") || Date.now() - sentAt > 90000) { sentAt = 0; seenWorking = false; }
    }
    let l = !write || !unitOk ? lockReason({ write, unitActive: unitOk }) : status.state !== "idle" && status.state !== "working" ? "status unknown" : sentAt ? "answering you; wait for it" : lockReason({ write, unitActive: unitOk, state: status.state, lastQuestion: status.question });
    if (l !== lock) { const was = lock; lock = l; paintHeader(); paintInput(); if (was && !l) out("🔓 typing is on again"); }
  };
  setup();
  out(write ? "Developer mode: what you type is marked as yours and reaches only the Doorman. It can't approve or run anything, and nothing you type goes to the sandbox." : "Observer mode: read-only. Nothing you do here reaches the Doorman.");
  let pos = 0;
  try { pos = Math.max(0, fs.statSync(f).size - 20000); } catch { /* none yet */ }
  let rbuf = "";
  const pump = () => {
    let fd; try { fd = fs.openSync(f, "r"); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size; if (size < pos) pos = 0;
      const b = Buffer.alloc(Math.min(size - pos, 1 << 20)); const n = fs.readSync(fd, b, 0, b.length, pos); pos += n; rbuf += b.toString("utf8", 0, n);
      let i; while ((i = rbuf.indexOf("\n")) >= 0) { const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1); try { const r = render(JSON.parse(line)); if (r) out(r); } catch { /* */ } }
    } finally { fs.closeSync(fd); }
  };
  refresh(); setInterval(() => { pump(); refresh(); }, 500); pump();
  process.stdout.on("resize", () => { setup(); });
  const send = () => {
    const pl = promptLine(buf);
    if (!pl) { buf = ""; return; }
    refresh();
    if (lock) { out(`🔒 not sent (${lock}); your line is held, press Enter again when typing is on`); if (!buf.endsWith(" ")) buf += " "; return; }
    try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, pl); fs.closeSync(fd); out(`🧑 you: ${clip(plain(buf), 300)}`); buf = ""; sentAt = Date.now(); seenWorking = false; refresh(); }
    catch (e) { out(`🔒 not sent: the Doorman's input isn't open (${e.code || e.message}); line held`); }
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8"); process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (c === "\x03" || c === "\x04") { P("\x1b[r\x1b[2J\x1b[H"); process.exit(0); }
      if (!write) continue;
      if (esc) { // inside an escape sequence (arrow keys etc.), possibly split across chunks: swallowed
        if (esc === 1) { esc = c === "[" || c === "O" ? 2 : 0; continue; }
        if (/[@-~]/.test(c)) esc = 0; continue;
      }
      if (c === "\x1b") { esc = 1; continue; }
      if (c === "\r" || c === "\n") send();
      else if (c === "\x7f" || c === "\b") buf = [...SEG.segment(buf)].slice(0, -1).map((x) => x.segment).join("");
      else if (c >= " ") buf += c;
    }
    paintInput();
  });
}

export function runView(cmd, a, b) {
  if (cmd === "log" && a) log(a);
  else if (cmd === "view" && a) view(a, b === "--write");
  else if (cmd === "fifo-line") process.stdout.write(promptLine(a) || "");
  else { console.error("usage: pi-doorman log NAME | view NAME [--write]"); process.exit(2); }
}
