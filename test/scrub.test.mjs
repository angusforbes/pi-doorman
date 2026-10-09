// The public-repo scrub: no personal paths, keys, internal hosts or private names anywhere in the package.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DENY = [
  [/\/home\/(?!user\b|agent\b)[a-z][\w-]*/i, "a personal home path"], [/\bagf\b/, "a user name"], [/nvidia/i, "an NVIDIA name"], [/hyprpi|hyprland|omarchy/i, "a host-integration name in core"],
  [/Obsidian/, "a private vault"], [/\b(?:sk|ghp|gho)-?[A-Za-z0-9_]{20,}/, "a key shape"], [/-----BEGIN [A-Z ]*PRIVATE KEY/, "a private key"],
  [/@(?!example\.)[\w-]+\.(?:com|net|org)\b/, "an email address"], [/inference-api|\.internal\b|\.corp\b/i, "an internal host"], [/\bGPU lease|world[- ]g\b|Thoughts[- ][A-Z]?\b|Thoughts\b|Doorman-[A-Z]\b|DoorReview|hyprctl/i, "a hyprpi-only concept"], [/\bOutside\b/, "a hyprpi-only concept (Outside)"], [/\/Users\/|~\/Work|~\/Harness|\bxox[abprs]-|\bAKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|slack\.com\/|\.amazonaws\.com/, "another private path or token shape"],
];
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === ".git" || e.name === "node_modules") continue; const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }
test("no personal or internal strings anywhere", () => {
  const bad = [];
  for (const f of walk(root)) {
    const rel = path.relative(root, f); if (rel === "test/scrub.test.mjs") continue;
    const text = fs.readFileSync(f, "utf8").replace(/github\.com\/angusforbes\/pi-(?:doorman|twin|jot)/g, "").replace(/Angus Forbes/g, "");
    for (const [re, why] of DENY) { const m = text.match(re); if (m) bad.push(`${rel}: ${why} (${m[0].slice(0, 30)})`); }
  }
  assert.deepEqual(bad, []);
});
test("package ships only what it should", () => { const p = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); assert.equal(p.license, "MIT"); assert.ok(!p.dependencies); assert.ok(p.bin["pi-doorman"]); });
import { execFileSync } from "node:child_process";
test("git history is clean too", () => {
  let log = ""; try { log = execFileSync("git", ["log", "-p", "--all", "--no-color"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }); } catch { return; } // not a checkout: nothing to scan
  const text = log.split(/^diff --git /m).filter((c) => !/^a\/test\/scrub\.test\.mjs /.test(c)).join("\n").replace(/^(?:Author|Commit): .*$/gm, "").replace(/github\.com\/angusforbes\/pi-(?:doorman|twin|jot)/g, "").replace(/Angus Forbes/g, "");
  const bad = DENY.map(([re, why]) => (re.test(text) ? why : null)).filter(Boolean);
  assert.deepEqual(bad, []);
});
