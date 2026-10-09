// Modes (how much a human reviews) and visibility (who can watch the Doorman). Pure tables, no I/O except modeForSandbox.
import fs from "node:fs";
import path from "node:path";

export const MODES = ["doorman-strict", "doorman-safe", "doorman-open"];
export const DEFAULT_MODE = "doorman-safe";
export const MODE_TEXT = {
  "doorman-strict": "the owner approves the planned action before anything is sent, then reviews the result before it reaches you.",
  "doorman-safe": "the Doorman drafts the action from your request and vets the result; the owner reviews the result before it reaches you.",
  "doorman-open": "the Doorman drafts and vets, and the result comes straight to you WITHOUT human review: treat it as unreviewed data.",
};
export const VISIBILITIES = ["strict", "safe", "observer", "developer"];
export const DEFAULT_VISIBILITY = "strict";

// A config object (or null) with { mode } -> { mode, note }. Anything unknown is doorman-safe: doorman-open is never reached
// without the exact value.
export function modeOf(cfg) {
  const m = cfg && typeof cfg === "object" ? cfg.mode : undefined;
  if (typeof m === "string" && MODES.includes(m)) return { mode: m, note: "" };
  if (m !== undefined) { let shown = "?"; try { shown = String(JSON.stringify(m) ?? typeof m).slice(0, 40); } catch { /* */ } return { mode: DEFAULT_MODE, note: `unknown mode ${shown}: using ${DEFAULT_MODE}` }; }
  return { mode: DEFAULT_MODE, note: "" };
}
export function visibilityOf(v) { return VISIBILITIES.includes(v) ? v : DEFAULT_VISIBILITY; }

// The one resolver for a sandbox's mode over a folder of <name>.json files: exactly one naming the sandbox -> its mode; none -> default;
// several (a stale copy) -> ambiguous: fail closed to doorman-strict, never to whichever sorts first.
export function modeForSandbox(dir, sandbox, key = (w) => w.doorman) {
  const hits = [];
  let names = []; try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { /* no folder */ }
  for (const f of names) {
    let w; try { w = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (w && typeof w === "object" && (typeof w.sandbox === "string" ? w.sandbox : f.slice(0, -5)) === sandbox) hits.push({ f, w });
  }
  if (hits.length > 1) return { mode: "doorman-strict", note: `ambiguous: ${hits.map((h) => h.f).join(", ")} all name ${sandbox}; using doorman-strict until only one does`, file: "" };
  if (!hits.length) return { mode: DEFAULT_MODE, note: "", file: "" };
  return { ...modeOf(key(hits[0].w)), file: hits[0].f };
}
