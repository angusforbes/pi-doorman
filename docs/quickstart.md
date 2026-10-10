# Quick start: a doorman with no agent on the host

You need Node 20+ and a sandbox (a container, a VM, any folder-isolated environment) that can mount three folders. No model key and no host agent. Every request is handled by code and every decision is yours.

## 1. Create the Doorman's folders

`pi-doorman init my-sandbox --mount rw:/work/app:workspace --mount ro:/work/lib:library --allow github.com`

This makes `~/.pi-doorman/my-sandbox/` (set `PI_DOORMAN_HOME` to move it) with an `outbox`, an `inbox`, a `card` (the host card and the network allowlist, both Markdown) and a `queue`. The card is what the sandbox is told about its walls; edit it freely.

## 2. Run the Doorman

`pi-doorman serve my-sandbox`

Rules answer first. Without a model key a question is answered from the card and every request is queued word for word for you.

## 3. Mount three folders into the sandbox

| host folder | in the sandbox | access |
|------|------|------|
| outbox | /home/agent/.pi-doorman/outbox | read-write |
| inbox | /home/agent/.pi-doorman/inbox | read-only |
| card | /home/agent/.sandbox | read-only |

The Doorman knows which sandbox wrote a message from the folder, never from what the message says.

## 4. Ask from inside

- `pi-doorman ask "can I write /work/lib/x?"` is answered from the card.
- `pi-doorman request "allow pypi.org" --why "pip install"` is drafted and waits for you. Nothing is granted until you decide.

Any agent can do the same: `pi-doorman mcp-config` prints the MCP setup for Claude Code, Codex and Pi, and `pi-doorman hook-config` prints the hooks.

## 5. Decide

- In a terminal: `pi-doorman review my-sandbox` shows each request with a binding code; approve with that code or deny.
- In a window: `pi-doorman view my-sandbox --write` shows the archive and takes decisions (1 approve, 2 deny, e approve with edits, r send back with a note). Anything typed is a decision on a held item, never a message to the Doorman.
- A desktop notification only denies or points you to the review; a notification never approves.

The answer comes back to the sandbox as a file in its inbox (`<id>.reply.json`).

An approved request does something only if you configured a runner for its kind in the sandbox's `config.json`; otherwise the reply says you will apply it by hand.

## Using a host agent (optional)

See [host-agents.md](host-agents.md): a Claude Code, Codex or Pi session on the host can take on approved open-ended jobs through the bridge.

## Check your setup

1. `pi-doorman card` inside the sandbox prints the card it sees.
2. A request you did not approve must not appear in any reply.
3. `npm test` in this repository runs the unit tests and a scrub test (no personal paths, keys or internal host names).
