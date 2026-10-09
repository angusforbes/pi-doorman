// Claude Code hook (PostToolUse / failure): when a tool result looks like a sandbox wall, say what it means and what to do.
// Reads the hook JSON on stdin; prints a short explanation as additionalContext. Plain script, no Pi needed.
const WALLS = [
  [/Blocked by org policy|403 Forbidden|Forbidden.*proxy|CONNECT tunnel failed/i, "A 403 from the sandbox proxy means the network policy blocks that domain. Nothing inside can change it: use an allowed source, or ask your Doorman (pi-doorman ask \"is DOMAIN allowed?\") and request it for the owner to approve."],
  [/Read-only file system|EROFS/i, "That folder is a read-only share: writes are refused on the host side, even with sudo. Don't work around it; send a draft or request for the owner (pi-doorman request \"what and why\")."],
  [/Could not resolve host|Temporary failure in name resolution/i, "The sandbox has no direct DNS; traffic goes through its policy proxy. Check the host card's Network section or ask your Doorman."],
  [/No such file or directory|command not found/i, "Missing in here says nothing about the host: the host's files and tools aren't visible. Run `pi-doorman ask \"...\"` or read the host card before assuming they exist."],
];
export function explain(text) { const hit = WALLS.find(([re]) => re.test(String(text ?? ""))); return hit ? hit[1] : null; }
export function runHook(raw) {
  let j = {}; try { j = JSON.parse(raw); } catch { /* */ }
  const r = j.tool_response ?? j.tool_result ?? j.error ?? "";
  const text = typeof r === "string" ? r : JSON.stringify(r);
  const e = explain(text); if (!e) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: j.hook_event_name || "PostToolUse", additionalContext: `pi-doorman: ${e}` } });
}
