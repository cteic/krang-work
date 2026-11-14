import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { candidates, closeFromPulls, linkedPulls, mergedPulls, pullState } from "./close-merged.ts";
import { exportLinear } from "./export-linear.ts";
import { McpClient, ollamaChat, runAgent } from "./local-agent.ts";
import { sendToVault } from "./obsidian.ts";
import { sortInbox } from "./sort-thoughts.ts";

import { importLinear } from "./import-linear.ts";
import { serve } from "./mcp-server.ts";
import { startServer } from "./web.ts";
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_LIST_LIMIT,
  THOUGHT_KINDS,
  WorkError,
  WorkStore,
  defaultWorkDir,
  isExposure,
  isIssueStatus,
  isPriority,
  isSensitivity,
  isThoughtKind,
} from "./work-store.ts";
import type {
  Issue,
  IssueStatus,
  Priority,
  Sensitivity,
  Thought,
  UpdateInput,
} from "./work-store.ts";

// The owner's interface to the work directory: issues, projects and thoughts.
// Everything here runs with local exposure: the person at the terminal sees
// every issue in full. `approve`, `review` and `set` exist only here; the MCP
// server has no equivalent.

interface Flags {
  positional: string[];
  values: Map<string, string[]>;
  switches: Set<string>;
}

const VALUE_FLAGS = new Set([
  "--dir",
  "--project",
  "--description",
  "--criterion",
  "--sensitivity",
  "--priority",
  "--label",
  "--remove-label",
  "--as",
  "--status",
  "--query",
  "--limit",
  "--lease",
  "--note",
  "--exposure",
  "--evidence",
  "--handoff",
  "--tag",
  "--title",
  "--due",
  "--prefix",
  "--port",
  "--kind",
  "--model",
  "--repo",
  "--owner",
  "--vault",
  "--steps",
]);
const SWITCHES = new Set([
  "--accept",
  "--reject",
  "--json",
  "--all",
  "--no-git",
  "--redo",
  "--apply",
  "--force",
  "--linked",
]);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { positional: [], values: new Map(), switches: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      flags.values.set(arg, [...(flags.values.get(arg) ?? []), value]);
      i++;
    } else if (SWITCHES.has(arg)) flags.switches.add(arg);
    else if (arg.startsWith("--")) fail(`Unknown flag ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

function one(flags: Flags, name: string): string | null {
  const values = flags.values.get(name);
  return values === undefined ? null : values[values.length - 1];
}

function many(flags: Flags, name: string): string[] {
  return flags.values.get(name) ?? [];
}

function wholeNumber(flags: Flags, name: string, fallback: number): number {
  const raw = one(flags, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(`${name} must be a whole number`);
  return value;
}

function sensitivityFlag(flags: Flags): Sensitivity | null {
  const raw = one(flags, "--sensitivity");
  if (raw === null) return null;
  if (!isSensitivity(raw)) fail('--sensitivity must be "normal" or "sensitive"');
  return raw;
}

function priorityFlag(flags: Flags): Priority | null {
  const raw = one(flags, "--priority");
  if (raw === null) return null;
  if (!isPriority(raw)) fail("--priority must be urgent, high, medium, low or none");
  return raw;
}

function statusFlag(flags: Flags): IssueStatus | null {
  const raw = one(flags, "--status");
  if (raw === null) return null;
  const value = raw.replace(/-/g, "_");
  if (!isIssueStatus(value)) fail(`Unknown status "${raw}"`);
  return value;
}

function actor(flags: Flags): string {
  return one(flags, "--as") ?? userInfo().username;
}

function need(flags: Flags, usage: string): string {
  const value = flags.positional[0];
  if (value === undefined) fail(`Usage: ${usage}`);
  return value;
}

function open(flags: Flags): WorkStore {
  return new WorkStore(one(flags, "--dir") ?? defaultWorkDir());
}

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof WorkError) fail(`${error.code}: ${error.message}`);
    throw error;
  }
}

function printIssue(issue: Issue): void {
  const approval = issue.approved
    ? `yes, by ${issue.approved_by ?? "?"} at ${issue.approved_at ?? "?"}`
    : "no";
  console.log(`${issue.id}  ${issue.title}`);
  console.log(`  status       ${issue.status}`);
  console.log(`  project      ${issue.project ?? "none"}`);
  console.log(`  priority     ${issue.priority}`);
  console.log(`  sensitivity  ${issue.sensitivity}`);
  console.log(`  approved     ${approval}`);
  if (issue.claimed_by !== null) {
    console.log(`  claimed by   ${issue.claimed_by} until ${issue.lease_expires_at ?? "?"}`);
  }
  if (issue.labels.length > 0) console.log(`  labels       ${issue.labels.join(", ")}`);
  if (issue.blocked_by.length > 0) console.log(`  blocked by   ${issue.blocked_by.join(", ")}`);
  if (issue.blocks.length > 0) console.log(`  blocks       ${issue.blocks.join(", ")}`);
  console.log(`  version      ${issue.version}`);
  if (issue.acceptance_criteria.length > 0) {
    console.log("  acceptance criteria");
    for (const criterion of issue.acceptance_criteria) console.log(`    - ${criterion}`);
  }
  if (issue.description !== "") console.log(`\n${issue.description}`);
  for (const entry of issue.log) {
    console.log(`\n--- ${entry.at} ${entry.actor} (${entry.kind})\n${entry.text}`);
  }
}

function show(flags: Flags, issue: Issue): void {
  if (flags.switches.has("--json")) console.log(JSON.stringify(issue, null, 2));
  else printIssue(issue);
}

function printRows(issues: Issue[]): void {
  if (issues.length === 0) {
    console.log("No issues.");
    return;
  }
  for (const issue of issues) {
    const marks = `${issue.approved ? "✓" : " "}${issue.sensitivity === "sensitive" ? "S" : " "}`;
    const holder = issue.claimed_by === null ? "" : `  @${issue.claimed_by}`;
    console.log(
      `${issue.id.padEnd(8)} ${issue.status.padEnd(11)} ${issue.priority.padEnd(6)} ${marks} ${(issue.project ?? "-").padEnd(24).slice(0, 24)} ${issue.title}${holder}`,
    );
  }
}

function change(id: string, flags: Flags, fields: Partial<UpdateInput>): UpdateInput {
  return {
    id,
    actor: actor(flags),
    expected_version: null,
    title: null,
    description: null,
    project: null,
    priority: null,
    labels: null,
    acceptance_criteria: null,
    sensitivity: null,
    status: null,
    add_comment: null,
    add_evidence: [],
    handoff: null,
    ...fields,
  };
}

// How many commits have touched issues/ since the last import. Null when the
// directory is not a git repository, so the answer cannot be known.
function localIssueChanges(root: string): number | null {
  if (!existsSync(join(root, ".git"))) return null;
  const subjects = execFileSync("git", ["-C", root, "log", "--format=%s", "--", "issues"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line !== "");
  const lastImport = subjects.findIndex((subject) => subject.startsWith("import:"));
  return lastImport === -1 ? subjects.length : lastImport;
}

function issueUsage(): never {
  console.error("Usage:");
  console.error(
    '  krang-work issue add "title" [--project <slug>] [--description "..."] [--criterion "..."]... [--priority high] [--label x]... [--sensitivity normal]',
  );
  console.error(
    "  krang-work issue ls [--project <slug>] [--status <status>] [--label x] [--query text] [--all] [--limit <n>]",
  );
  console.error("  krang-work issue show <id>");
  console.error("  krang-work issue approve <id>                    owner only; allows a claim");
  console.error('  krang-work issue review <id> --accept|--reject [--note "..."]    owner only');
  console.error(
    '  krang-work issue set <id> [--status s] [--priority p] [--project slug] [--label x] [--remove-label x] [--criterion "..."] [--due YYYY-MM-DD] [--sensitivity s]',
  );
  console.error('  krang-work issue comment <id> "text"');
  console.error("  krang-work issue claim <id> --as <actor> [--lease <seconds>]");
  console.error(
    '  krang-work issue submit <id> --as <actor> --evidence "..."... [--handoff "..."]',
  );
  console.error("  krang-work issue release <id> --as <actor>");
  console.error("  krang-work issue cancel <id>");
  console.error("Every command takes --dir <path>; otherwise KRANG_WORK_DIR, then ~/krang-work.");
  process.exit(1);
}

export function issue(subcommand: string | undefined, rest: string[]): void {
  if (subcommand === undefined) issueUsage();
  const flags = parseFlags(rest);
  const store = open(flags);
  guarded(() => {
    if (subcommand === "add") {
      show(
        flags,
        store.create({
          title: need(flags, 'krang-work issue add "title"'),
          description: one(flags, "--description") ?? "",
          project: one(flags, "--project"),
          priority: priorityFlag(flags) ?? "none",
          labels: many(flags, "--label"),
          acceptance_criteria: many(flags, "--criterion"),
          sensitivity: sensitivityFlag(flags) ?? "sensitive",
          actor: actor(flags),
        }),
      );
    } else if (subcommand === "ls") {
      const status = statusFlag(flags);
      const issues = store.list({
        project: one(flags, "--project"),
        status,
        label: one(flags, "--label"),
        query: one(flags, "--query"),
        open_only: status === null && !flags.switches.has("--all"),
        limit: wholeNumber(flags, "--limit", DEFAULT_LIST_LIMIT),
      });
      if (flags.switches.has("--json")) console.log(JSON.stringify(issues, null, 2));
      else printRows(issues);
    } else if (subcommand === "show") {
      show(flags, store.get(need(flags, "krang-work issue show <id>")));
    } else if (subcommand === "approve") {
      show(flags, store.approve(need(flags, "krang-work issue approve <id>"), actor(flags)));
    } else if (subcommand === "review") {
      const accept = flags.switches.has("--accept");
      if (accept === flags.switches.has("--reject")) fail("Give exactly one of --accept, --reject");
      const id = need(flags, "krang-work issue review <id> --accept|--reject");
      show(flags, store.review(id, actor(flags), accept, one(flags, "--note")));
    } else if (subcommand === "set") {
      show(
        flags,
        store.ownerSet(need(flags, "krang-work issue set <id> ..."), actor(flags), {
          status: statusFlag(flags),
          priority: priorityFlag(flags),
          project: one(flags, "--project"),
          sensitivity: sensitivityFlag(flags),
          add_labels: many(flags, "--label"),
          remove_labels: many(flags, "--remove-label"),
          add_criteria: many(flags, "--criterion"),
          due: one(flags, "--due"),
        }),
      );
    } else if (subcommand === "comment") {
      const words = flags.positional[1];
      if (words === undefined) fail('Usage: krang-work issue comment <id> "text"');
      const id = need(flags, 'krang-work issue comment <id> "text"');
      show(flags, store.update(change(id, flags, { add_comment: words }), "local"));
    } else if (subcommand === "claim") {
      const lease = wholeNumber(flags, "--lease", DEFAULT_LEASE_SECONDS);
      show(
        flags,
        store.claim(need(flags, "krang-work issue claim <id>"), actor(flags), lease, "local"),
      );
    } else if (subcommand === "submit") {
      const id = need(flags, "krang-work issue submit <id>");
      show(
        flags,
        store.update(
          change(id, flags, {
            status: "in_review",
            add_evidence: many(flags, "--evidence"),
            handoff: one(flags, "--handoff"),
          }),
          "local",
        ),
      );
    } else if (subcommand === "release") {
      const id = need(flags, "krang-work issue release <id>");
      show(flags, store.update(change(id, flags, { status: "todo" }), "local"));
    } else if (subcommand === "cancel") {
      const id = need(flags, "krang-work issue cancel <id>");
      show(flags, store.update(change(id, flags, { status: "cancelled" }), "local"));
    } else issueUsage();
  });
}

function printThought(thought: Thought): void {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(thought.created)) / 86400000));
  const tags = thought.tags.map((tag) => `#${tag}`).join(" ");
  const first = thought.text.split("\n")[0];
  const kind = thought.kind === null ? "" : `[${thought.kind}] `;
  console.log(
    `${thought.id}  ${String(days).padStart(3)}d  ${kind}${first}${tags === "" ? "" : `  ${tags}`}`,
  );
  if (thought.suggested_kind !== null) {
    const suggested = thought.suggested_tags.map((tag) => ` #${tag}`).join("");
    console.log(`${" ".repeat(23)}suggested: ${thought.suggested_kind}${suggested}`);
  }
}

// The model to use, and where it runs. The host defaults to Ollama on this
// machine; the callers refuse a host that is anywhere else.
function localModel(flags: Flags): { host: string; model: string; keepAlive: string } {
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const model = one(flags, "--model") ?? process.env.KRANG_WORK_MODEL;
  if (model === undefined || model === "") {
    fail("Name a local model with --model <name>, or set KRANG_WORK_MODEL.");
  }
  return { host: host.startsWith("http") ? host : `http://${host}`, model, keepAlive: "5m" };
}

async function sortThoughts(flags: Flags, store: WorkStore): Promise<void> {
  const local = localModel(flags);
  console.log(
    `Sorting the inbox with ${local.model} at ${local.host}. Nothing leaves this machine.`,
  );
  const count = await sortInbox(store, {
    ...local,
    redo: flags.switches.has("--redo"),
    onResult: (thought, suggestion, seconds) => {
      const verdict =
        suggestion === null
          ? "no usable answer"
          : `${suggestion.kind}${suggestion.tags.map((tag) => ` #${tag}`).join("")}`;
      console.log(
        `${thought.id}  ${seconds.toFixed(1)}s  ${verdict}  | ${thought.text.split("\n")[0].slice(0, 60)}`,
      );
    },
  });
  console.log(`${count} suggestions written. Confirm one with: krang-work thoughts keep <id>`);
}

// `krang-work jot "text"` is the whole capture path: one command, no required
// flags, no model. Anything that made it slower would make it unused.
export function jot(args: string[]): void {
  const flags = parseFlags(args);
  const words = flags.positional.join(" ");
  if (words.trim() === "") fail('Usage: krang-work jot "the thought" [--tag <tag>]...');
  const thought = guarded(() => open(flags).jot(words, many(flags, "--tag"), actor(flags)));
  console.log(`${thought.id}  saved to ${thought.file}`);
}

export async function thoughts(first: string | undefined, rest: string[]): Promise<void> {
  // `krang-work thoughts --all` has a flag where the subcommand would be.
  const bare = first === undefined || first.startsWith("--");
  const subcommand = bare ? "ls" : first;
  const flags = parseFlags(bare && first !== undefined ? [first, ...rest] : rest);
  const store = open(flags);
  if (subcommand === "sort") {
    try {
      await sortThoughts(flags, store);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  guarded(() => {
    if (subcommand === "ls") {
      const state = flags.switches.has("--all") ? "notes" : "inbox";
      const found = store.thoughts(state);
      if (found.length === 0)
        console.log(state === "inbox" ? "The inbox is empty." : "Nothing kept yet.");
      for (const thought of found) printThought(thought);
    } else if (subcommand === "show") {
      const thought = store.findThought(need(flags, "krang-work thoughts show <id>"));
      console.log(`${thought.file}\n\n${thought.text}`);
    } else if (subcommand === "keep") {
      const kind = one(flags, "--kind");
      if (kind !== null && !isThoughtKind(kind)) {
        fail(`--kind must be one of: ${THOUGHT_KINDS.join(", ")}`);
      }
      const kept = store.keepThought(
        need(flags, "krang-work thoughts keep <id> [--kind <kind>]"),
        kind,
      );
      console.log(`${kept.id}  kept as ${kept.kind ?? "idea"} in ${kept.file}`);
    } else if (subcommand === "issue") {
      const id = need(flags, 'krang-work thoughts issue <id> --title "..."');
      const title = one(flags, "--title");
      if (title === null)
        fail('Usage: krang-work thoughts issue <id> --title "..." [--project <slug>]');
      const created = store.thoughtToIssue(id, {
        title,
        project: one(flags, "--project"),
        priority: priorityFlag(flags) ?? "none",
        labels: many(flags, "--label"),
        acceptance_criteria: many(flags, "--criterion"),
        sensitivity: sensitivityFlag(flags) ?? "sensitive",
        actor: actor(flags),
      });
      console.log(`${created.id}  created from thought ${id}`);
    } else if (subcommand === "send") {
      const vault = one(flags, "--vault");
      if (vault === null)
        fail("Usage: krang-work thoughts send <id> --vault <path-to-obsidian-vault>");
      const thought = store.findThought(
        need(flags, "krang-work thoughts send <id> --vault <path>"),
      );
      const sent = sendToVault(thought, vault, new Date().toISOString());
      console.log(`${thought.id}  proposed in the vault as "${sent.path}"`);
      console.log(
        sent.tag === null
          ? "  A plain note: this vault has no candidate tag for its kind."
          : `  Tagged #${sent.tag}. In Obsidian, hover the tag and choose to create the node.`,
      );
    } else if (subcommand === "archive") {
      const archived = store.archiveThought(need(flags, "krang-work thoughts archive <id>"));
      console.log(`${archived.id}  archived`);
    } else {
      console.error("Usage:");
      console.error(
        "  krang-work thoughts [ls] [--all]               the inbox, oldest first; --all shows kept notes",
      );
      console.error("  krang-work thoughts show <id>");
      console.error(`  krang-work thoughts keep <id> [--kind ${THOUGHT_KINDS.join("|")}]`);
      console.error(
        '  krang-work thoughts issue <id> --title "..." [--project <slug>]   turn it into an issue',
      );
      console.error("  krang-work thoughts archive <id>");
      console.error(
        "  krang-work thoughts send <id> --vault <path>   propose it as a note in an Obsidian vault",
      );
      console.error(
        "  krang-work thoughts sort --model <name> [--redo]   a local model suggests kind and tags",
      );
      process.exit(1);
    }
  });
}

export async function work(subcommand: string | undefined, rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const store = open(flags);
  if (subcommand === "path") {
    console.log(store.root);
  } else if (subcommand === "init") {
    const prefix = one(flags, "--prefix");
    if (prefix === null) fail("Usage: krang-work init --prefix <KEY> [--no-git]");
    guarded(() => store.init(prefix, !flags.switches.has("--no-git")));
    console.log(`Created ${store.root}`);
  } else if (subcommand === "projects") {
    guarded(() => {
      const all = store
        .all()
        .filter((item) => item.status !== "done" && item.status !== "cancelled");
      for (const project of store.projects()) {
        const count = all.filter((item) => item.project === project.slug).length;
        console.log(
          `${project.slug.padEnd(32)} ${project.status.padEnd(12)} ${String(count).padStart(3)} open  ${project.name}`,
        );
      }
    });
  } else if (subcommand === "import-linear") {
    const dir = need(flags, "krang-work import-linear <export-dir>");
    const report = guarded(() => importLinear(store, dir));
    console.log(JSON.stringify(report, null, 2));
  } else if (subcommand === "export-linear") {
    const dir = need(flags, "krang-work export-linear <new-dir>");
    console.log(JSON.stringify(await exportLinear(dir), null, 2));
  } else if (subcommand === "refresh-linear") {
    // Linear is the record until the owner switches. A refresh overwrites the
    // imported issues, so it refuses once anything local has changed them.
    const changed = guarded(() => localIssueChanges(store.root));
    if (changed !== 0 && !flags.switches.has("--force")) {
      fail(
        changed === null
          ? "This work directory has no git history, so local changes cannot be ruled out. Use --force to overwrite."
          : `${changed} commits have changed issues here since the last import. A refresh would overwrite them. Use --force if that is what you want.`,
      );
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
    const dir = join(homedir(), "krang-work-linear-export", stamp);
    const exported = await exportLinear(dir);
    const report = guarded(() => importLinear(store, dir, true));
    console.log(JSON.stringify({ export: exported.dir, ...report }, null, 2));
  } else if (subcommand === "close-merged") {
    const apply = flags.switches.has("--apply");
    const repo = one(flags, "--repo");
    if (repo !== null) {
      const pulls = mergedPulls(repo, wholeNumber(flags, "--limit", 100));
      const closures = guarded(() =>
        closeFromPulls(store, store.prefix(), pulls, actor(flags), apply),
      );
      for (const closure of closures) {
        console.log(
          `${closure.id.padEnd(8)} ${closure.outcome.padEnd(14)} #${closure.pull.number} ${closure.pull.title}`,
        );
      }
      if (closures.length === 0) console.log(`No merged pull request in ${repo} closes an issue.`);
      else if (!apply) console.log("Nothing was changed. Run again with --apply to close them.");
    } else if (flags.switches.has("--linked")) {
      // Issues whose linked pull requests have all merged. Listed, never closed
      // in bulk: a link is weaker than a closing word, so each is named to close.
      const owners = many(flags, "--owner").map((owner) => owner.toLowerCase());
      if (owners.length === 0)
        fail("Usage: krang-work close-merged --linked --owner <github-owner>...");
      const found = guarded(() => candidates(linkedPulls(store, owners), pullState));
      for (const candidate of found) {
        console.log(`${candidate.id.padEnd(8)} ${candidate.title}`);
        for (const url of candidate.merged) console.log(`           finished: ${url}`);
      }
      console.log(
        found.length === 0
          ? "No open issue has all of its linked pull requests and GitHub issues finished."
          : `${found.length} open issues look finished. Close one with: krang-work issue set <id> --status done`,
      );
    } else {
      fail(
        "Usage: krang-work close-merged --repo <owner/name> [--apply] [--limit 100]\n       krang-work close-merged --linked --owner <github-owner>...",
      );
    }
  } else if (subcommand === "serve") {
    const port = wholeNumber(flags, "--port", 4747);
    guarded(() => store.all());
    startServer(store, port);
    console.log(
      `Krang work is at http://127.0.0.1:${port}  (read only, this machine only; Ctrl-C to stop)`,
    );
    await new Promise(() => {});
  } else if (subcommand === "agent") {
    // A local model with the MCP tools and nothing else. The server it talks
    // to runs with local exposure, which is right only because the model is
    // on this machine: ollamaChat refuses any other address.
    const task = need(flags, 'krang-work agent "task" --model <name>');
    const local = localModel(flags);
    guarded(() => store.all());
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const client = new McpClient(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      cli,
      "mcp",
      "--exposure",
      "local",
      "--dir",
      store.root,
    ]);
    console.log(`Local agent: ${local.model} at ${local.host}. Tools: the work store only.`);
    try {
      await runAgent(client, ollamaChat(local.host, local.model), {
        task,
        actor: one(flags, "--as") ?? "local-agent",
        maxSteps: wholeNumber(flags, "--steps", 12),
        onEvent: (event) => {
          const text =
            event.kind === "result" ? event.text.replace(/\s+/g, " ").slice(0, 200) : event.text;
          console.log(`${event.kind.padEnd(7)} ${text}`);
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      client.close();
    }
  } else if (subcommand === "mcp") {
    const exposure = one(flags, "--exposure") ?? "cloud";
    if (!isExposure(exposure)) fail('--exposure must be "cloud" or "local"');
    console.error(`[krang-work] serving ${store.root} over stdio, exposure: ${exposure}`);
    await serve(store, exposure, process.stdin, process.stdout);
  } else {
    console.error("Usage:");
    console.error(
      "  krang-work issue <add|ls|show|approve|review|set|comment|claim|submit|release|cancel> ...",
    );
    console.error('  krang-work jot "a thought" [--tag <tag>]...');
    console.error("  krang-work thoughts <ls|show|keep|issue|archive|sort|send> ...");
    console.error("  krang-work init --prefix <KEY> [--no-git]   create the work directory");
    console.error("  krang-work path");
    console.error("  krang-work projects");
    console.error("  krang-work import-linear <export-dir>       into an empty work directory");
    console.error("  krang-work export-linear <new-dir>          read-only copy of Linear as JSON");
    console.error(
      "  krang-work refresh-linear [--force]         export, then re-import over the last import",
    );
    console.error(
      "  krang-work close-merged --repo <owner/name> [--apply]   close issues named by merged PRs",
    );
    console.error("  krang-work serve [--port 4747]              read-only page in a browser");
    console.error("  krang-work mcp [--exposure cloud|local]     stdio MCP server; default cloud");
    console.error(
      '  krang-work agent "task" [--model <name>] [--as <actor>] [--steps 12]   a local model with the MCP tools only',
    );
    process.exit(1);
  }
}
