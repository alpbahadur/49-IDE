# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Running Several Instances Side by Side (development)

Each worktree can run its own full stack — cloud server plus agent — without
touching the others. This exists for development: reviewing a branch while the
main instance keeps running, or testing a change against a scratch database.
It is not a user-facing feature.

An instance is identified by the cloud URL its agent connects to. Everything
that could collide is derived from that key:

| Resource | Default instance (port 1071) | Any other instance |
|---|---|---|
| Database | `cloud/data/tc.db` | `cloud/data/tc-<port>.db` |
| Agent config, token, PID | `~/.49agents/` | `~/.49agents/instances/<key>/` |
| Terminal (ttyd) ports | 7700-7719 | a distinct 20-port block in 7700-7899 |
| tmux server | the default socket | `tmux -L <key>` |

The default instance deliberately keeps the original paths and the standard
tmux socket, so a normal single-instance setup is unaffected and existing
sessions stay visible.

### Starting one

```bash
# Cloud server on its own port — the database path follows from PORT
PORT=2400 node cloud/src/index.js

# Agent for that server — the instance key follows from TC_CLOUD_URL
TC_CLOUD_URL=ws://localhost:2400 node agent/bin/49-agent.js start
```

`TC_INSTANCE` overrides the derived key, which is only needed to run two
agents against the *same* server — an unusual case.

Terminals created in one instance live on that instance's tmux server, so they
never appear in another instance's dashboard and cannot be closed from it.

### One agent per instance

Starting a second agent for an instance that already has one is refused, by
the CLI (via the instance's PID file) and by the relay (a connection whose
socket is still open is not replaced). Both print what is already running and
how to proceed.

This matters because two agents sharing an instance share its token, so they
authenticate as the same agent and the relay drops one of them — and both
drive the same tmux sessions in the meantime. If an agent needs to run
alongside another, give it a different `TC_CLOUD_URL` rather than forcing it
onto the same instance.

`--force` skips the CLI check. It is for recovering from a PID file that
survived a hard kill, not for running two agents on one instance.

### Cleaning up

A stopped instance leaves its database, config directory and tmux server
behind. To remove one completely:

```bash
49-agent stop                                  # with TC_CLOUD_URL set
tmux -L <key> kill-server                      # its terminals
rm -rf ~/.49agents/instances/<key>             # its config and token
rm -f cloud/data/tc-<port>.db*                 # its database
```

Kill agents by the PID recorded in the instance's PID file. Pattern-matching
on the process name (`pkill -f 49-agent`) hits every agent on the machine,
including the one serving the main instance.

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Auto-syncs to JSONL for version control
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs with git:

- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->

## Landing the Plane (Session Completion)

**When ending a work session**, record completed work and any remaining approval dependency. Pushing or redeploying requires direct approval. For Global-assigned work, ask the assigning Global; default to Ordubashy if unclear.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - Only after explicit go-ahead for this work and target:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - Report committed, pushed and merged status separately
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Preserve the task branch and report to the assigning Global while approval is pending.
- Continue independent assigned work while waiting; terminal output is not a handoff.
- If an approved push fails, preserve the commits and report the failure; never force-push over others.
