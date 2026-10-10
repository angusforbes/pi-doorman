# Host agents: Claude Code, Codex or Pi through the bridge (planned)

Status: design. The fixed request types need no agent. The bridge below is for open-ended jobs, once the owner approves one, and it is off unless the owner turns on host jobs. Until it ships in this package, the host-side commands here are not available; the quick start covers what works today.

## The idea

An approved free-form request becomes a job with state `waiting`. A host agent, any harness, takes jobs through one CLI (`doorman-bridge`) or an MCP server that wraps it:

| command | what it does |
|------|------|
| list | jobs waiting |
| claim ID | take one job (a lease) |
| show ID | the owner's approved text and limits |
| ask ID TEXT | a question for the owner, held in the window |
| report ID | done, failed or partial, with what was run |
| release ID | give it back unfinished |

## Rules

- The agent sees only what the owner approved (possibly edited), never the sandbox's own words.
- A claim has a lease; a crashed agent's job returns to waiting and is marked abandoned. A job that ends without a report is marked "no report".
- `ask` is the only way back to the owner, through the decision window.
- The bridge is host-side only (a local socket or a 0600 folder). The sandbox never gets it: a sandbox that could claim or report jobs would have a way around the wall.
- Start the agent with only the tools and folders the job allows, for example Claude Code with `--allowedTools` and `--add-dir`. A throwaway sandbox or a separate user is stronger for anything that writes.

## Claude Code, for example

`claude mcp add pi-doorman-bridge -- npx -y pi-doorman bridge-mcp` (name to be confirmed when the bridge lands), then in a session: "list the Doorman's jobs, claim the first and do it; ask me through the Doorman if unsure; report at the end."

Without a host agent nothing here is needed; unsupported open-ended asks are simply declined.
