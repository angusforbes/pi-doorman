// The human side that always works: a terminal review. Notifications live in notify.mjs.
import readline from "node:readline";

// pi-doorman review NAME: one pending request at a time, shown in full with its binding code.
export async function terminalReview(svc, io = { input: process.stdin, output: process.stdout }) {
  const rl = readline.createInterface(io); const ask = (q) => new Promise((r) => rl.question(q, r));
  let n = 0;
  for (const e of svc.list().filter((x) => x.status === "pending")) {
    io.output.write(`\n== request ${e.id}  (binding code ${e.code})\n${e.summary}\n`);
    const a = (await ask("approve / deny / skip? [a/d/S] ")).trim().toLowerCase();
    if (a === "a" || a === "approve") { io.output.write((await svc.decide(e.id, true, e.code)).text + "\n"); n++; }
    else if (a === "d" || a === "deny") { io.output.write((await svc.decide(e.id, false, e.code)).text + "\n"); n++; }
  }
  rl.close(); return n;
}
