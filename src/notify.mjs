// Notifier interface: notifier({ decide, reviewCmd }) -> (entry) => void. An adapter shows the owner a request and, where the
// platform can, a Deny button. `pi-doorman review NAME` always works, so every adapter degrades to a plain
// "run pi-doorman review" note. Adapters: freedesktop (Linux, over D-Bus via notify-send) now; macos and windows come later.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const has = (c) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0;
// Does the running notification daemon support action buttons? (freedesktop "actions" capability; ask the server over D-Bus.)
// The arguments for one notification. A notification can NEVER approve (an accidental tap or a stale toast must not be able to):
// it offers only Deny (one click, the safe choice) where the daemon supports buttons, and always points at the full review,
// where approving is typed with the binding code after the whole request is shown.
export function notifyArgs(e, { actions = false, reviewCmd = "pi-doorman review" } = {}) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // notification daemons may render markup
  const whole = e.summary.length <= 600;
  const body = esc(whole ? e.summary : `${e.summary.slice(0, 300)}…`) + `\n\nbinding code ${e.code}\nApprove only in the full review: ${esc(reviewCmd)}`;
  return ["--app-name=pi-doorman", ...(actions ? ["--wait", "--action=deny=Deny"] : []), `Doorman request ${e.code}`, body];
}
export function freedesktop({ decide, reviewCmd = "pi-doorman review", actions = freedesktopHasActions() }) {
  if (!has("notify-send")) return null;
  return (e) => {
    const p = spawn("notify-send", notifyArgs(e, { actions, reviewCmd }), { stdio: ["ignore", "pipe", "ignore"], detached: true }); let o = "";
    p.on("error", () => {}); p.stdout.on("data", (d) => (o += d));
    p.on("close", () => { if (o.trim() === "deny") decide(e.id, false); }); // only a denial is ever decided from a notification
    p.unref();
  };
}
export const ADAPTERS = { linux: freedesktop, darwin: () => null, win32: () => null }; // darwin / win32: adapters later
export function notifier(opts) { try { return (ADAPTERS[os.platform()] ?? (() => null))(opts) ?? (() => {}); } catch { return () => {}; } }
