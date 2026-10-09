// Request kinds are plug-ins: { name, precheck(msg), render(msg), run?(msg, cfg) }. Core ships ask, request and draft.
// A plug-in module default-exports a kind or an array of kinds; list them in config.json as "plugins": ["/abs/path.mjs"].
// Each kind lists its `fields` (default for a plug-in: text only); only those reach the review and the runner, so what the human sees is all that runs.
// Hooks a kind may add (all optional): plan(msg, ctx) -> msg, check(plan) -> string|null (a complaint), vet(result) -> string|null.
// A kind's run() only ever happens after a human approval, and only through a runner the owner configured (config.runners[kind]).
import { pathToFileURL } from "node:url";

const TOKEN = /\b(?:sk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY/;
// Every inbound field of every kind is scanned for secret shapes before anything else happens.
export function scanFields(m) { for (const k of ["text", "why", "action", "target", "patch"]) if (TOKEN.test(String(m[k] ?? ""))) return "looks like it contains a key or token"; return null; }
export const baseKinds = {
  ask: { name: "ask", review: false, fields: ["text"], precheck: () => null, render: (m) => `Question: ${m.text}` },
  request: { name: "request", review: true, fields: ["text", "why", "action"], precheck: (m) => (TOKEN.test(`${m.text} ${m.why ?? ""} ${m.action ?? ""}`) ? "looks like it contains a key or token" : null), render: (m) => `Request: ${m.text}${m.why ? `\nWhy: ${m.why}` : ""}${m.action ? `\nExact action: ${m.action}` : ""}` },
  draft: { name: "draft", review: true, fields: ["text", "target", "patch"], precheck: (m) => (m.patch && String(m.patch).length > 200000 ? "patch too large" : TOKEN.test(`${m.text} ${m.patch ?? ""}`) ? "looks like it contains a key or token" : null), render: (m) => `Draft for ${m.target || "(no target)"}: ${m.text}${m.patch ? `\n--- proposed change ---\n${String(m.patch).slice(0, 6000)}` : ""}` },
};
export async function loadKinds(cfg = {}) {
  const kinds = { ...baseKinds };
  for (const p of cfg.plugins ?? []) {
    const mod = await import(pathToFileURL(String(p)).href);
    for (const k of [].concat(mod.default ?? [])) if (k?.name && !baseKinds[k.name]) kinds[k.name] = { review: true, ...k, fields: Array.isArray(k.fields) ? k.fields : ["text"] }; // a plug-in declares which fields it shows and runs; the rest are dropped
  }
  return kinds;
}
