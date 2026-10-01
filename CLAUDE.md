NEVER WORK IN MASTER NO MATTER WHAT
WHENEVER WORKING ON A FEATURE, MAKE YOURSELF A WORKTREE AND A BRANCH. WORK THERE ONLY. COMMIT FREELY THERE, BUT DO NOT MERGE INTO MASTER UNLESS CLEARLY INSTRUCTED BY THE USER

use bd commands for managing beads issues. always use beads.

IF YOU ARE ASSIGNED A SPECIFIC BEADS TASK, WHEN CREATING A WORKTREE AND A BRANCH, MAKE SIURE TO ADD THE BEADS ISSUE ID ON THE END OF THE NAME OF THE WORKTREE AND BRANCH - MAKE SURE TO GIVE NORMAL NAME AND THE JUST APPEND IT WITH THE BEAD ISSUE ID IF GIVEN A BEADS ISSUE. OTHERWISE, JUST ASK THE USER IF YOU SHOULD MAP IT TO SOME BEADS ISSUE OR MAKE ONE.

DO NOT CLOSE BEADS ISSUES YOURSELF. ONLY CLOSE BEADS ISSUES WHEN USER TELLS YOU TO. NEVER MERGE YOURSELF. USER HAS TO APPROVE EVERY EVERY EVERY MERGE HIMSELF EXPLICITLY AND SEPARATELY.

WHENEVER USER TELLS YOU TO RESOLVE A BEADS ISSUE, RESOLVE IT IN THE MASTER, NOT IN YOUR BRANCH/WORKTREE!!!

Pushing or redeploying requires direct approval. For Global-assigned work, ask the Global who assigned the task and wait for their explicit go-ahead; default to Ordubashy if unclear. Global-agent instructions carry Alp's authority for delegated work. Report results, blockers, questions and review artifacts to that Global; Alp does not monitor terminal output. Commit freely in your task branch. Existing explicit owner holds and merge rules still apply.

COMMIT OFTEN IN YOUR OWN BRANCH.
IF YOU HAVE BEEN ASSIGNED A BEADS ISSUE, INCLUDE THE BEADS ISSUE ID IN THE NAME OF THE BRANCH OR WORKTREE YOU ARE WORKING ON. IF MORE THAN ONE ISSUES ASSIGNED RELATED TO THE SAME LARGER PROBLEM AND ALL ARE ISSUES ARE GOING TO BE WORKED ON THE SAME BRANCH THEN INCLUDE AL THE ISSUE IDS INTO THE WORKTREE AND BRANCH NAMES.

JS MINIFICATION & OBFUSCATION:
Client-side JS source files live in cloud/src-client/ (app.js, themes.js, analytics.js).
They are NOT in cloud/public/ — only obfuscated .min.js builds are served from public/.
After changing source files, rebuild the minified versions:
  cd cloud && npm run build
HTML files reference .min.js versions so this must be done before restarting the cloud server.

REBUILDING AGENT TARBALL:
After changing any agent code (agent/src/, agent/services/, agent/bin/), rebuild the tarball that users download:
  tar czf cloud/dl/49-agent.tar.gz agent/

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
