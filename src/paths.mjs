import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Standalone state: ~/.pi-doorman/<sandbox>/ (override the root with PI_DOORMAN_HOME).
export const home = () => process.env.PI_DOORMAN_HOME || path.join(os.homedir(), ".pi-doorman");
export const dirs = (name) => { const d = path.join(home(), name); return { root: d, outbox: path.join(d, "outbox"), inbox: path.join(d, "inbox"), queue: path.join(d, "queue"), card: path.join(d, "card"), config: path.join(d, "config.json") }; };
export const okName = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(String(n));
export function readConfig(name) { try { return JSON.parse(fs.readFileSync(dirs(name).config, "utf8")) || {}; } catch { return {}; } }
export const safeText = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
