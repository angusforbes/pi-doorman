// The fake review provider for test/pty/answer-paste.py: one held question; decide() only records what it was given.
import fs from "node:fs";
export default function createReview() {
  return {
    current() { return { id: "door--abc123", text: "host agent question", choices: ["a", "2"], answer: true }; },
    decide(id, k, edited, note) {
      fs.appendFileSync(process.env.REVIEW_CAPTURE, JSON.stringify({ id, k, note }) + "\n");
      return { ok: true, text: "captured in temp fixture" };
    },
  };
}
