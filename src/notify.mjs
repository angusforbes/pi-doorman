// Notifier interface: notifier({ decide, reviewCmd }) -> (entry) => void. An adapter shows the owner a request and, where the
// platform can, offers Approve / Deny buttons. `pi-doorman review NAME` always works, so every adapter degrades to a plain
// "run pi-doorman review" note. Adapters: freedesktop (Linux, over D-Bus via notify-send) now; macos and windows come later.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const has = (c) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0;
// Does the running notification daemon support action buttons? (freedesktop "actions" capability; ask the server over D-Bus.)
export function freedesktopHasActions() {
  if (!has("gdbus")) return false;
  const r = spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.GetCapabilities"], { encoding: "utf8" });
  return r.status === 0 && /'actions'/.test(r.stdout);
}
export function freedesktop({ decide, reviewCmd = "pi-doorman review", actions = freedesktopHasActions() }) {
  if (!has("notify-send")) return null;
  return (e) => {
    // Approve / Deny only when the notification shows the WHOLE request; a longer one just points at the full review.
    const whole = e.summary.length <= 600, buttons = actions && whole;
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // notification daemons may render markup
    const body = esc(whole ? e.summary : `${e.summary.slice(0, 300)}…\n(too long to approve from a notification)`) + `\n\nbinding code ${e.code}` + (buttons ? "" : `\nReview in full: ${esc(reviewCmd)}`);
    const args = ["--app-name=pi-doorman", ...(buttons ? ["--wait", "--action=approve=Approve", "--action=deny=Deny"] : []), `Doorman request ${e.code}`, body];
    const p = spawn("notify-send", args, { stdio: ["ignore", "pipe", "ignore"], detached: true }); let o = "";
    p.on("error", () => {}); p.stdout.on("data", (d) => (o += d));
    p.on("close", () => { const a = o.trim(); if (a === "approve" || a === "deny") decide(e.id, a === "approve", e.code); });
    p.unref();
  };
}
export const ADAPTERS = { linux: freedesktop, darwin: () => null, win32: () => null }; // darwin / win32: adapters later
export function notifier(opts) { try { return (ADAPTERS[os.platform()] ?? (() => null))(opts) ?? (() => {}); } catch { return () => {}; } }
