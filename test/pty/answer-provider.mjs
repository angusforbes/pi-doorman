// The fake review provider for test/pty/answer-paste.py: one held question; decide() only records what it was given.
import fs from "node:fs";
export default function createReview() {
  return {
    current() { return { id: "door--abc123", text: "host agent question", choices: (process.env.REVIEW_CHOICES || "1,2").split(","), answer: process.env.REVIEW_ANSWER !== "0" }; },
    decide(id, k, note, opts = {}) { // (J412: decide(id, key, text, { minutes }))
      fs.appendFileSync(process.env.REVIEW_CAPTURE, JSON.stringify({ id, k, note, ...(opts.minutes ? { minutes: opts.minutes } : {}) }) + "\n");
      return { ok: true, text: "captured in temp fixture" };
    },
  };
}
