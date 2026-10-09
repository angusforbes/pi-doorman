---
name: sandbox-guide
description: You are inside a sandbox (a separate machine). Use this BEFORE assuming a host file, folder, tool or website exists, and whenever something fails in a way that might be the sandbox's walls (a path missing, "Read-only file system", a 403 "Blocked by org policy", a command not found). It explains what is shared, what the network policy blocks and what to do next.
---

# The sandbox guide (inner guide)

You run in a sandbox: a separate machine. The host's files, tools and processes are not visible, except a few shared folders. Some shares sit at the same paths as on the host (e.g. the owner's Work folder), which can make it look like you're on the host: you aren't.

Run `sandbox-guide` (overview), or ask about one thing:

- `sandbox-guide why /some/path`: is it shared? read-only?
- `sandbox-guide why example.com`: reachable, or blocked by the network policy?
- `sandbox-guide why sometool`: installed in here?
- `sandbox-guide card`: this sandbox's own card (to give to a host agent on first contact).

Rules:

- Something missing here says nothing about the host. Ask the host (your Doorman or host contact) before assuming.
- Read-only shares can't be written, even with sudo. Don't try workarounds; ask.
- A domain blocked by the policy can't be unblocked from inside. Use an allowed source or ask the host owner.
- On first contact with a host agent, ask: "would you build us a host card?", and offer this sandbox's card in return.

## Card formats (for first contact)

Host card (Markdown, written by the host side; ask for it): header lines `card: host-card/1`, `host:`, `written:`, `sandbox:`; then sections `## Shared folders` (a table: mode, path as seen in here, what), `## Tools on the host`, `## Network`, `## How to ask` (free text: how to reach the host), `## Withheld` (names at most, never contents).

Sandbox card: `sandbox-guide card` prints it (`card: sandbox-card/1`, sandbox, system, user, model, purpose, owner; Shares, Network, Tools, Withheld). Purpose and owner are filled in by the sandbox's owner.
