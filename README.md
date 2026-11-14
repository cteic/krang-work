# krang-work

A hosted issue tracker is built for people clicking in a browser. Most of the reading and writing on my tickets is now done by coding agents, and they are better served by files.

krang-work is a local issue tracker where every issue, project and passing thought is a Markdown file. I read them in Obsidian. Agents read them with `grep`, or through an MCP server (a small program that gives an agent tools). There is no database, no account and no runtime dependency. It needs Node 22.6 or later and nothing else.

It is a prototype, a few days old, with one user.

## Try it

```bash
git clone https://github.com/pete-watters/krang-work.git && cd krang-work
./demo.sh
```

The demo uses a throwaway folder, no network and no model. A thought becomes an issue. An agent tries to claim it and is refused. I approve it. Two agents race and one wins. The winner submits evidence, I accept, and `git log` shows the trail.

## Agents propose, a person decides

The tracker has seven MCP tools. An agent can list, read, create, update and claim issues, list projects and save a thought. Two things are missing on purpose: there is no tool to approve an issue and no tool to mark one done. Those exist on the command line only.

| Rule                                        | How it holds                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Only the owner approves work                | `approve` is a CLI command. The MCP tools have no approval field, and an unknown field is refused |
| Only the owner marks work done              | An agent can move an issue to `in_review`, never to `done`                                        |
| One claimant per issue                      | Every write takes one lock, made by creating a directory, which the filesystem makes atomic       |
| No review without evidence                  | Moving to `in_review` needs at least one evidence entry from the claimant                         |
| A rewritten issue loses its approval        | Changing the title, description or criteria clears `approved`                                     |
| Blocked work waits                          | A claim is refused while an issue it is blocked by is unfinished                                  |
| A cloud model never reads a sensitive issue | The server returns a stub and refuses to change or claim the issue                                |

That last rule needs a sentence of explanation. The server can't tell what model sits behind its client, so whoever starts it says: `--exposure cloud` is the default and hides sensitive issues, `--exposure local` shows everything. New issues are sensitive unless you say otherwise.

## An issue is a file

```markdown
---
id: WORK-12
title: "Add a --version flag"
status: todo
project: cli
priority: high
sensitivity: normal
approved: true
blocked_by: []
acceptance_criteria:
  - "Running with --version prints the version and exits 0"
version: 3
---

# Add a --version flag

The description, in Markdown.

<!-- krang:log -->

### 2026-11-14T10:00:00.000Z · agent-a · evidence

What was run and what it printed.
```

Edit it by hand if you like. The store reads the file fresh on every call, and it writes back any frontmatter it doesn't own, so another tool's fields survive. When the folder is a git repository each change is one commit, which makes `git log issues/WORK-12.md` the issue's history.

## Daily use

```bash
krang-work init --prefix WORK
krang-work jot "a thought, in your own words" --tag idea
krang-work thoughts                           # the inbox, oldest first
krang-work thoughts issue <id> --title "..."  # or: keep <id>, archive <id>

krang-work issue ls
krang-work issue add "Title" --criterion "..."
krang-work issue approve WORK-12
krang-work issue review WORK-12 --accept

krang-work serve     # read-only page at http://127.0.0.1:4747
krang-work mcp       # stdio MCP server
```

`KRANG_WORK_DIR` or `--dir` chooses the folder. The default is `~/krang-work`.

To connect an MCP client:

```json
{
  "mcpServers": {
    "krang-work": {
      "command": "node",
      "args": ["--experimental-strip-types", "/path/to/krang-work/src/cli.ts", "mcp"]
    }
  }
}
```

## Thoughts are not work

I had started asking an assistant about every half-formed idea because that was quicker than writing it down. `jot` is one command with no required flags and no model involved. A thought has no status and no owner. It becomes an issue only if I say so, and most never will.

A model on my own machine can sort the inbox:

```bash
krang-work thoughts sort --model <an Ollama model>
```

It proposes a kind for each thought (question, claim, evidence, source or idea) and up to three tags. The proposal sits beside the thought and changes nothing until `thoughts keep` confirms it. The command refuses any model address that isn't this machine, and the MCP server has no tool that returns a thought.

## A local agent

```bash
krang-work agent "Find the approved issue, claim it, do it, submit evidence" --model <name>
```

This hands the seven tools to a local model and nothing else: no shell, no file access. In one run a 9-billion-parameter model read a sensitive issue, claimed it, added its evidence, tried to mark the issue done and was refused. It then reported that it had submitted the work for review. It hadn't. Read the issue, not the summary.

## Obsidian and Discourse Graphs

Open the folder as a vault and everything is a readable note.

`krang-work thoughts send <id> --vault <path>` writes a kept thought into a vault as a plain proposal. If the vault runs the [Discourse Graphs](https://discoursegraphs.com) plugin, the thought's line carries the vault's own candidate tag for its kind, such as `#clm-candidate`, and the plugin offers to turn it into a node. The note never carries a node type and relations are never written. Confirming is a click by the person.

This is not a Discourse Graphs implementation. It borrows one idea from that project's own agent tools: stage the finding, and let a person promote it.

## Moving off a hosted tracker

`export-linear` copies a Linear workspace to JSON with read-only queries. `import-linear` turns that into files and keeps every issue id, so `Closes WORK-123` in an old pull request still names the right file. I moved 209 issues and 12 projects this way and checked every title, description and comment count against the export.

`close-merged --linked` lists open issues whose linked pull requests have all merged. It lists them and closes nothing.

## What is tested

- 41 tests, run with Node's own test runner: `npm test`.
- Ten processes racing for five issues. Each issue is claimed exactly once.
- The MCP server as a child process over stdio, and one real MCP client against it.
- The web page escapes everything it shows. Its Markdown renderer is checked against a list of the only tags it may write.

Not tested: Windows, any remote transport, and the Discourse Graphs plugin acting on a proposal. I have read that plugin's source and checked its files in a live vault, but I have not yet clicked through the conversion.

## Limits

- **Actor names are not authenticated.** The server believes the `actor` string.
- **The rules bind the CLI and the MCP server, not the files.** An agent with a shell can run `approve`, and an agent with file access can edit an issue directly. Git history shows the edit. The boundary is real for an agent that only has the MCP tools.
- **Exposure is a declaration.** Start the server with `--exposure local` under a cloud client and it will show that client everything.
- **Text a cloud model types has already left the machine.** The store stops a sensitive issue being read back. It can't unsend a request.
- **Files are not encrypted.** They rely on disk encryption and folder permissions.
- **One machine writes at a time.** The lock is local.
- **The protocol is written by hand.** It covers `initialize`, `ping`, `tools/list` and `tools/call` for protocol versions 2024-11-05, 2025-03-26 and 2025-06-18. No resources, prompts or pagination.

## Licence

AGPL-3.0-only. See `LICENSE`.
