# pi-doorman

A doorman for sandboxed agents. Being in a sandbox is like having SSH'd into another machine and being blind to the host: the agent needs help understanding its walls, without being given a way around them. pi-doorman explains the walls from a host card, answers "why" questions with deterministic rules first, and turns "I need something from outside" into a short drafted request that a human approves. It never approves or runs anything by itself.

It serves any agent (Claude Code, Codex, Cursor, Pi) through an MCP server, a CLI and hooks, and is built on [Pi](https://github.com/earendil-works/pi) for the optional model calls.

## How it works

- Host card: a plain Markdown file (`host-card/1`) the host writes and mounts read-only into the sandbox: shared folders, network allowlist, how to ask, what is withheld. A sandbox card (`sandbox-card/1`) goes the other way.
- Inner guide: `guide/sandbox-guide` (standard-library Python) and a skill text explain a failure from inside (a missing path, a read-only share, a 403).
- Doorman service (host side): rules first (is this path shared, is this domain allowed), then optionally one stateless model call through Pi, then a queue of drafted requests.
- Channel: a drop-box. The sandbox writes JSON files to an outbox and reads replies from a read-only inbox; the host service identifies the sandbox by the folder, never by the message. Size and rate limits apply.
- Review: a desktop notification (Deny and a pointer to the review only: a notification never approves), or `pi-doorman review NAME` in a terminal. Every request shows a binding code. An approval runs only a runner you configured for that kind.
- Request kinds are plug-ins. Core ships `ask`, `request` and `draft`; add more with `"plugins": ["/path/kind.mjs"]` in the sandbox's config.json.
- Modes (`doorman-strict`, `doorman-safe`, `doorman-open`) and visibility (`strict`, `safe`, `observer`, `developer`: with decisions) are shared vocabulary: `src/modes.mjs` resolves them, and request-kind plug-ins and host integrations decide what each mode adds (the built-in `request` and `draft` kinds always wait for a human whatever the mode). `pi-doorman view NAME [--write]` is the observer / developer window for a Doorman running as a Pi RPC process whose events go through `pi-doorman log`; it locks whenever typing would not be sent.

## Quick start

```
pi-doorman init my-sandbox --mount rw:/work/app:workspace --mount ro:/work/lib:library --allow github.com
pi-doorman serve my-sandbox
```

Mount `~/.pi-doorman/my-sandbox/outbox` (read-write), and `inbox` and `card` (read-only), into the sandbox at `/home/agent/.pi-doorman/outbox`, `/home/agent/.pi-doorman/inbox` and `/home/agent/.sandbox` (override the three paths inside with `PI_DOORMAN_OUTBOX`, `PI_DOORMAN_INBOX`, `PI_DOORMAN_CARD`). Then connect the agent inside:

```
pi-doorman mcp-config
pi-doorman hook-config
```

Inside the sandbox: `pi-doorman ask "can I write /work/lib/x?"`, `pi-doorman request "allow pypi.org" --why "pip install"`.

Without a model key the service runs rules-only: `ask` is answered from the card, and everything else is queued verbatim for review. Setting `"model": "provider/id"` in the sandbox's config.json (needs Pi on the host) lets the model answer `ask` questions the rules can't. Requests are never drafted or granted by a model; they always wait for a human.

## The window: an archive and a place to decide

`pi-doorman view NAME [--write]` shows the Doorman's conversation (loaded from the event log, scrollable) and, with `--write`, takes decisions on what a host integration holds for the owner. There is no way to talk to the Doorman from it: nothing typed in the window reaches the Doorman model (the window has no input path to it at all), and with nothing held a typed line only gets a notice. Point `PI_DOORMAN_REVIEW_MODULE` at an ES module whose default export `createReview(name)` returns `{ current(), decide(id, choice, edited?, note?), edit?(id), track?(id) }`:

- `current()` returns `null` or `{ id, text, choices, reason? }` (choices are "1", "2", "3", "e", "r"; `reason: true` when a deny can carry a reason): the integration's own record of what is waiting for the owner. The window draws it in full, in a colour of its own (`PI_DOORMAN_REVIEW_COLOR`), with the input and status lines switched to that colour while it is showing. Rows are marked with control characters that are stripped from everything the Doorman or a sandbox says, so their words can never be drawn as the request.
- A bare `1` / `2` / `3` typed while an item is showing goes to `decide(id, choice)`, only after the item has been on screen for 2 seconds and only if it is still the one waiting; otherwise a notice says why and nothing is sent.
- `e` (approve with modifications), when offered: the window opens `edit(id)`'s text in the owner's `$VISUAL` / `$EDITOR`, shows the original and the edited version, and after the same 2 second rule `1` calls `decide(id, "1", editedText)`. The integration must re-check the edit and keep both versions.
- `info()` (optional) returns one line (for example the models, mode and level in effect) shown dimmed under the header.
- `r <note>` (send it back), when offered: the item is withdrawn, not approved, and `decide(id, "r", undefined, note)` passes the owner's note on to whoever wrote the item, so they can revise it; the revision should come back as a new held item. `2 <reason>`, when `reason` is true, calls `decide(id, "2", undefined, reason)` so the asker learns why. The window cleans a note or reason (no control characters, whitespace collapsed) and refuses one over 500 characters; the integration must clean it again, label it as the owner's, and never send anything out because of it. Both obey the same 2 second rule.
- `track(id)` (optional) follows a decided request to where it ended up: `{ state, text, done }`, state `pending` / `approved` / `denied` / `returned` / `gone`.

The package ships no decision logic: `decide`, `edit` and `track` are the integration's.

## Security contract

Limits are enforced outside the model; the Doorman's prompt saying "talk only" is not the wall. Routing is bound to identity. Cards and messages are data, never instructions or permissions. The authoritative card lives in host-controlled storage. Every field is scanned and strings that look like keys or tokens are refused. A sandbox can't reuse a request id, can't make the host read a symlink or FIFO, and is limited in size and rate. A request is shown to the owner in full (anything too long to review whole is refused), approving needs its binding code, and a decision is claimed atomically so it can run only once. This is a helper for a sandbox, not a sandbox.

## Tests

`npm test` (Node 20+, no dependencies) runs the unit tests and a scrub test that fails on personal paths, keys or internal host names.

MIT licence.
