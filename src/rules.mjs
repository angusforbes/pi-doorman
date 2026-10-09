// Deterministic answers first: most "why" questions never need a model. Returns { answer, certain } or null when the card can't say.
import path from "node:path";
import { parseHostCard, parseAllowlist } from "./card.mjs";

const norm = (p) => path.posix.normalize(String(p).replace(/\/+$/, "") || "/");
const inside = (p, root) => p === root || p.startsWith(root + "/");

export function pathAnswer(card, p) {
  const q = norm(p);
  const best = card.mounts.filter((m) => inside(q, norm(m.path))).sort((a, b) => b.path.length - a.path.length)[0];
  if (best) return best.mode === "rw" ? `${q} is inside the shared folder ${best.path} (writable).` : `${q} is inside the shared folder ${best.path}, which is READ-ONLY: writes are refused on the host side, even with sudo. Draft a request if you need a change.`;
  return `${q} isn't one of the shared folders on your host card, so this says nothing about whether it exists on the host. Ask for it with a request if you need it.`;
}
export function domainAnswer(allow, d) {
  const host = String(d).toLowerCase().replace(/^https?:\/\//, "").split(/[/:?#]/)[0];
  const hit = allow.find((a) => a.toLowerCase() === host || (a.startsWith("*.") && host.endsWith(a.slice(1).toLowerCase())));
  if (hit) return `${host} is on the allowlist (${hit}), though a rule may restrict paths or methods.`;
  return allow.length ? `${host} is not on the allowlist, so the sandbox's proxy will refuse it. Nothing inside can change that; use an allowed source or draft a request for the owner.` : null;
}

export function answer(question, { cardMd = "", allowMd = "" } = {}) {
  const card = parseHostCard(cardMd), allow = parseAllowlist(allowMd), q = String(question ?? "");
  const pm = q.match(/(?:^|\s)((?:\/|~\/)[\w.\-/@+ ]*[\w.\-/@+])/);
  if (pm) return { answer: pathAnswer(card, pm[1].replace(/^~/, "/home/user")), certain: true };
  const dm = q.match(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/\S*)?/i);
  if (dm) { const a = domainAnswer(allow, dm[1]); if (a) return { answer: a, certain: true }; }
  if (/\b(shared|mount|folder|share)s?\b/i.test(q)) return { answer: card.mounts.length ? "Shared folders on your host card:\n" + card.mounts.map((m) => `- ${m.mode} ${m.path}${m.what ? ` (${m.what})` : ""}`).join("\n") : "Your host card lists no shared folders.", certain: true };
  return null;
}
