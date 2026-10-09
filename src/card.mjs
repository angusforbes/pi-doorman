// The open card formats: host-card/1 (written by the host, read-only inside the sandbox) and sandbox-card/1.
// Generators take plain data (a list of mounts, tools, rules), never a particular tool's config.
const cell = (s) => String(s ?? "").replace(/[|\n\r]/g, " ").trim();

export function buildHostCard({ host = "the host", sandbox = "sandbox", written = new Date().toISOString().slice(0, 10), writer = "pi-doorman", mounts = [], tools = "", network = {}, howToAsk = "", withheld = "", mode = "", extra = [] } = {}) {
  const L = ["# Host card", "", "card: host-card/1", `host: ${cell(host)}`, `written: ${cell(written)} by ${cell(writer)}`, `sandbox: ${cell(sandbox)}`, "", "## Shared folders", ""];
  if (mounts.length) { L.push("| mode | path | what |", "|------|------|------|"); for (const m of mounts) L.push(`| ${m.mode === "rw" ? "rw" : "ro"} | ${cell(m.path)} | ${cell(m.what)} |`); L.push("", "Everything else on the host is not shared."); }
  else L.push("Nothing is shared.");
  L.push("", "## Tools on the host", "", tools || "Host tools aren't visible in here. Ask the Doorman to have something done on the host; you can't run host commands.");
  L.push("", "## Network", "");
  L.push(network.summary || "Your requests go through the sandbox's policy proxy. The host can't change it from in here; new domains need a request by the owner.");
  if (network.rules?.length) { L.push("", "Allowed (see net-allowlist.md for the full list):"); for (const r of network.rules.slice(0, 40)) L.push(`- ${cell(r)}`); }
  if (mode) L.push("", "## Request mode", "", `${cell(mode)}`);
  L.push("", "## How to ask", "", howToAsk || "- Ask your Doorman (always allowed, no approval needed): `pi-doorman ask \"question\"`.\n- Anything that needs the owner is drafted as a request and waits for approval: `pi-doorman request \"what and why\"`.");
  for (const e of extra) L.push("", `## ${cell(e.title)}`, "", e.body);
  L.push("", "## Withheld", "", withheld || "Other folders, credentials and anything not listed above are not described.", "");
  return L.join("\n");
}

export function buildSandboxCard({ sandbox = "sandbox", system = "", user = "", model = "", purpose = "", owner = "", shares = [], network = "", tools = "" } = {}) {
  const L = ["# Sandbox card", "", "card: sandbox-card/1", `sandbox: ${cell(sandbox)}`, `system: ${cell(system)}`, `user: ${cell(user)}`, `model: ${cell(model)}`, `purpose: ${cell(purpose)}`, `owner: ${cell(owner)}`, "", "## Shares", ""];
  if (shares.length) { L.push("| mode | path |", "|------|------|"); for (const s of shares) L.push(`| ${s.mode === "rw" ? "rw" : "ro"} | ${cell(s.path)} |`); } else L.push("None.");
  L.push("", "## Network", "", network || "unknown", "", "## Tools", "", tools || "unknown", "", "## Withheld", "", "Secrets, conversations and files outside the shares above are not described.", "");
  return L.join("\n");
}

// Read back what the rules engine needs from a host card.
export function parseHostCard(md) {
  const text = String(md ?? ""), card = { header: {}, mounts: [], sections: {} };
  let sec = "";
  for (const line of text.split("\n")) {
    const h = line.match(/^## (.+)$/); if (h) { sec = h[1].trim(); card.sections[sec] = []; continue; }
    if (!sec) { const m = line.match(/^([a-z-]+): (.*)$/); if (m) card.header[m[1]] = m[2]; continue; }
    card.sections[sec].push(line);
    if (sec === "Shared folders") { const r = line.match(/^\|\s*(rw|ro)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|?$/); if (r) card.mounts.push({ mode: r[1], path: r[2], what: r[3] }); }
  }
  return card;
}

export function parseAllowlist(md) { return String(md ?? "").split("\n").map((l) => l.match(/^[-*]\s+`?([A-Za-z0-9.*-]+\.[A-Za-z]{2,}|\*\.[A-Za-z0-9.-]+)`?/)?.[1]).filter(Boolean); }
