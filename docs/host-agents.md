# Host agents: Claude Code, Codex or Pi through the bridge

Status: built and being moved into this package; a real Claude Code session has worked a job through the MCP server end to end. The fixed types need no agent. The bridge below is for open-ended jobs, once the owner approves one, and it is off unless the owner turns on host jobs. Until it ships here, the host-side commands below are not available; the quick start covers what works today.

## The idea

An approved free-form request becomes a job with state `waiting`. A host agent, any harness, takes jobs through one CLI (`doorman-bridge`) or an MCP server (`doorman-bridge mcp`, tools list_jobs, show_job, claim_job, renew_job, ask_owner, report_job, release_job, plus read_settings and propose_settings) that wraps it:

| command | what it does |
|------|------|
| list | jobs waiting |
| claim ID | take one job (a lease) |
| show ID | the owner's approved text and limits |
| ask ID TEXT | a question for the owner, held in the window |
| report ID | done, failed or partial, with what was run |
| renew ID | extend the lease |
| release ID | give it back unfinished |
| settings | read the host's settings (read-only) |
| propose | a settings change, held for the owner |

## Rules

- The agent sees only what the owner approved (possibly edited), never the sandbox's own words.
- A claim has a lease; a crashed agent's job returns to waiting and is marked abandoned. A job that ends without a report is marked "no report".
- `ask` is the only way back to the owner, through the decision window.
- The bridge is host-side only (a local socket or a 0600 folder). The sandbox never gets it: a sandbox that could claim or report jobs would have a way around the wall.
- Start the agent with only the tools and folders the job allows, for example Claude Code with `--allowedTools` and `--add-dir`. A throwaway sandbox or a separate user is stronger for anything that writes.

## Only the MCP config

The MCP server describes itself, so a host agent needs no long first prompt:

- When it connects, it sends the rules as MCP instructions: list, claim, show, do only what's approved, ask the owner when unsure, report.
- With `DOORMAN_BRIDGE_AGENT` set, it registers the agent under that name on connect, keeps the registration alive, and removes it when the session closes.
  - The harness is the client's own name, or `DOORMAN_BRIDGE_HARNESS`.
  - `DOORMAN_BRIDGE_SCOPE` and `DOORMAN_BRIDGE_CAPS` are optional.
- Its MCP prompt `check` does the next waiting job.
- A skill with the same rules ships beside it (`skill/doorman-bridge/SKILL.md`), for clients that don't show MCP instructions.

Claude Code, for example:

```json
{ "mcpServers": { "doorman-bridge": { "command": "doorman-bridge", "args": ["mcp"], "env": { "DOORMAN_BRIDGE_AGENT": "Doorman-Host", "DOORMAN_STATE": "/path/to/the/doorman/state" } } } }
```

`claude --strict-mcp-config --mcp-config bridge-mcp.json --restricted --tools Read,Write,Edit --add-dir <the folders jobs may use>`, then `/mcp__doorman-bridge__check` whenever you want the next job done.

Without a host agent nothing here is needed; unsupported open-ended asks are simply declined.
