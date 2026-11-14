import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseJsonRecord, numberField, stringField } from "./json-record.ts";
import { flag, integer, list, parse, serialize, slugify, text } from "./markdown.ts";
import type { FieldValue } from "./markdown.ts";

// The work store: issues, projects and thoughts as Markdown files in one
// directory. A person reads them in an editor; an agent reads them with grep.
// There is no database: the files are the record, and when the
// directory is a git repository every change is a commit, which is the history.
//
//   work/
//     work.json                 the id prefix and the next issue number
//     issues/WORK-208.md        one file per issue; the path never changes
//     projects/<slug>.md
//     thoughts/inbox/<id>-<slug>.md      captured, not yet looked at
//     thoughts/notes/                    kept, with a kind
//     thoughts/archive/                  dropped, or turned into an issue
//
// Three rules live here rather than in a caller, so no interface can skip them:
//
//   1. Approval and acceptance are the owner's. The functions that grant them
//      are separate, and only the CLI calls them.
//   2. Every write happens under one lock, taken by creating a directory,
//      which the filesystem makes atomic. Two processes racing to claim an
//      issue cannot both read "unclaimed".
//   3. A reader declares its exposure. A "cloud" reader gets a stub for a
//      sensitive issue, and that is the default.

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type Sensitivity = "normal" | "sensitive";
export type Exposure = "local" | "cloud";
export type LogKind = "comment" | "evidence" | "handoff";
export type ThoughtKind = "question" | "claim" | "evidence" | "source" | "idea";
export type ThoughtState = "inbox" | "notes" | "archive";

export const STATUSES: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];
export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low", "none"];
export const THOUGHT_KINDS: ThoughtKind[] = ["question", "claim", "evidence", "source", "idea"];
const LOG_KINDS: LogKind[] = ["comment", "evidence", "handoff"];

function oneOf<T extends string>(values: T[], value: string): value is T {
  return values.some((candidate) => candidate === value);
}

export function isIssueStatus(value: string): value is IssueStatus {
  return oneOf(STATUSES, value);
}
export function isPriority(value: string): value is Priority {
  return oneOf(PRIORITIES, value);
}
export function isSensitivity(value: string): value is Sensitivity {
  return value === "normal" || value === "sensitive";
}
export function isExposure(value: string): value is Exposure {
  return value === "local" || value === "cloud";
}
export function isThoughtKind(value: string): value is ThoughtKind {
  return oneOf(THOUGHT_KINDS, value);
}

export interface LogEntry {
  at: string;
  actor: string;
  kind: LogKind;
  text: string;
}

export interface Issue {
  id: string;
  title: string;
  status: IssueStatus;
  project: string | null;
  priority: Priority;
  labels: string[];
  sensitivity: Sensitivity;
  approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  parent: string | null;
  blocks: string[];
  blocked_by: string[];
  related: string[];
  due: string | null;
  acceptance_criteria: string[];
  links: string[];
  from_thought: string | null;
  created_by: string;
  created: string;
  updated: string;
  version: number;
  description: string;
  log: LogEntry[];
  // Frontmatter this store does not know, kept in order and written back
  // untouched. Another tool's fields (an Obsidian plugin's, say) survive a write.
  extra: [string, FieldValue][];
}

export interface RedactedIssue {
  id: string;
  project: string | null;
  status: IssueStatus;
  sensitivity: "sensitive";
  approved: boolean;
  claimed: boolean;
  created: string;
  updated: string;
  redacted: true;
}

export type IssueView = Issue | RedactedIssue;

export interface Project {
  slug: string;
  id: string | null;
  name: string;
  status: string;
  summary: string;
  lead: string | null;
  target: string | null;
  milestones: string[];
  created: string;
  updated: string;
  body: string;
}

export interface Thought {
  id: string;
  state: ThoughtState;
  file: string;
  created: string;
  tags: string[];
  kind: ThoughtKind | null;
  written_by: string;
  became: string | null;
  // A local model's proposal for kind and tags. It is shown beside the thought
  // and does nothing until the owner keeps the thought.
  suggested_kind: ThoughtKind | null;
  suggested_tags: string[];
  suggested_by: string | null;
  text: string;
  extra: [string, FieldValue][];
}

export type WorkErrorCode =
  | "invalid_input"
  | "not_found"
  | "not_approved"
  | "already_claimed"
  | "not_claimable"
  | "blocked"
  | "not_claimant"
  | "invalid_transition"
  | "version_conflict"
  | "forbidden"
  | "exists";

export class WorkError extends Error {
  readonly code: WorkErrorCode;

  constructor(code: WorkErrorCode, message: string) {
    super(message);
    this.name = "WorkError";
    this.code = code;
  }
}

export interface CreateInput {
  title: string;
  description: string;
  project: string | null;
  priority: Priority;
  labels: string[];
  acceptance_criteria: string[];
  sensitivity: Sensitivity;
  actor: string;
}

export interface UpdateInput {
  id: string;
  actor: string;
  expected_version: number | null;
  title: string | null;
  description: string | null;
  project: string | null;
  priority: Priority | null;
  labels: string[] | null;
  acceptance_criteria: string[] | null;
  sensitivity: Sensitivity | null;
  status: "todo" | "in_review" | "cancelled" | null;
  add_comment: string | null;
  add_evidence: string[];
  handoff: string | null;
}

export interface ListFilter {
  project: string | null;
  status: IssueStatus | null;
  label: string | null;
  query: string | null;
  open_only: boolean;
  limit: number;
}

// What the owner may set directly, past the rules agents work under.
export interface OwnerPatch {
  status: IssueStatus | null;
  priority: Priority | null;
  project: string | null;
  sensitivity: Sensitivity | null;
  add_labels: string[];
  remove_labels: string[];
  add_criteria: string[];
  due: string | null;
}

export const DEFAULT_LEASE_SECONDS = 3600;
export const MAX_LEASE_SECONDS = 86400;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const LIMITS = {
  title: 200,
  description: 40000,
  criterion: 500,
  criteria: 20,
  label: 64,
  labels: 20,
  entry: 20000,
  actor: 64,
  thought: 20000,
  tags: 10,
};

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const ISSUE_ID = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
const THOUGHT_ID = /^\d{8}T\d{6}(x\d+)?$/;
const TAG = /^[a-z0-9][a-z0-9/_-]*$/;
const LOG_MARKER = "<!-- krang:log -->";
const LOG_HEADER = /^### (\S+) · (\S+) · (comment|evidence|handoff)$/;

export function isIssueId(value: string): boolean {
  return ISSUE_ID.test(value);
}

// KRANG_WORK_DIR relocates the store, for tests and the demo.
export function defaultWorkDir(): string {
  const override = process.env.KRANG_WORK_DIR;
  if (override !== undefined && override !== "") return override;
  return join(homedir(), "krang-work");
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new WorkError("invalid_input", `${field} must not be empty`);
  if (trimmed.length > max) {
    throw new WorkError("invalid_input", `${field} is longer than ${max} characters`);
  }
  return trimmed;
}

function requireSlug(value: string, field: string): string {
  const slug = value.trim();
  if (!SLUG.test(slug) || slug.length > 64) {
    throw new WorkError("invalid_input", `${field} must be lower-case letters, digits and hyphens`);
  }
  return slug;
}

export function requireActor(value: string): string {
  const actor = value.trim();
  if (!ACTOR.test(actor) || actor.length > LIMITS.actor) {
    throw new WorkError("invalid_input", "actor must be letters, digits and . _ @ -");
  }
  return actor;
}

function requireIssueId(value: string): string {
  if (!isIssueId(value)) throw new WorkError("invalid_input", `"${value}" is not an issue id`);
  return value;
}

function requireLabels(values: string[]): string[] {
  if (values.length > LIMITS.labels) {
    throw new WorkError("invalid_input", `at most ${LIMITS.labels} labels`);
  }
  return [...new Set(values.map((value) => requireText(value, "label", LIMITS.label)))];
}

function requireCriteria(values: string[]): string[] {
  if (values.length > LIMITS.criteria) {
    throw new WorkError("invalid_input", `at most ${LIMITS.criteria} acceptance criteria`);
  }
  return values.map((value) =>
    requireText(value, "acceptance criterion", LIMITS.criterion).replace(/\s*\n\s*/g, " "),
  );
}

export function requireTags(values: string[]): string[] {
  if (values.length > LIMITS.tags) throw new WorkError("invalid_input", "at most 10 tags");
  return [
    ...new Set(
      values.map((value) => {
        const tag = value.trim().replace(/^#/, "").toLowerCase();
        // Obsidian refuses a tag that is only digits, so this does too.
        if (!TAG.test(tag) || /^\d+$/.test(tag) || tag.length > 64) {
          throw new WorkError(
            "invalid_input",
            `"${value}" is not a tag: use lower-case letters, digits, - _ /`,
          );
        }
        return tag;
      }),
    ),
  ];
}

// --- issue files -------------------------------------------------------------

function escapeLogText(value: string): string {
  return value
    .split("\n")
    .map((line) => (LOG_HEADER.test(line) || line === LOG_MARKER ? ` ${line}` : line))
    .join("\n");
}

const ISSUE_KEYS = new Set([
  "id",
  "title",
  "status",
  "project",
  "priority",
  "labels",
  "sensitivity",
  "approved",
  "approved_by",
  "approved_at",
  "claimed_by",
  "lease_expires_at",
  "parent",
  "blocks",
  "blocked_by",
  "related",
  "due",
  "acceptance_criteria",
  "links",
  "from_thought",
  "created_by",
  "created",
  "updated",
  "version",
]);

const THOUGHT_KEYS = new Set([
  "id",
  "created",
  "tags",
  "kind",
  "written_by",
  "became",
  "suggested_kind",
  "suggested_tags",
  "suggested_by",
]);

export function renderIssue(issue: Issue): string {
  const fields: [string, FieldValue][] = [
    ["id", issue.id],
    ["title", issue.title],
    ["status", issue.status],
    ["project", issue.project],
    ["priority", issue.priority],
    ["labels", issue.labels],
    ["sensitivity", issue.sensitivity],
    ["approved", issue.approved],
    ["approved_by", issue.approved_by],
    ["approved_at", issue.approved_at],
    ["claimed_by", issue.claimed_by],
    ["lease_expires_at", issue.lease_expires_at],
    ["parent", issue.parent],
    ["blocks", issue.blocks],
    ["blocked_by", issue.blocked_by],
    ["related", issue.related],
    ["due", issue.due],
    ["acceptance_criteria", issue.acceptance_criteria],
    ["links", issue.links],
    ["from_thought", issue.from_thought],
    ["created_by", issue.created_by],
    ["created", issue.created],
    ["updated", issue.updated],
    ["version", issue.version],
    ...issue.extra,
  ];
  const parts = [`# ${issue.title}`, "", escapeLogText(issue.description.trim())];
  if (issue.log.length > 0) {
    parts.push("", LOG_MARKER);
    for (const entry of issue.log) {
      parts.push("", `### ${entry.at} · ${entry.actor} · ${entry.kind}`, "");
      parts.push(escapeLogText(entry.text.trim()));
    }
  }
  return serialize(fields, parts.join("\n"));
}

function parseLog(source: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;
  let lines: string[] = [];
  const close = () => {
    if (current !== null) entries.push({ ...current, text: lines.join("\n").trim() });
  };
  for (const line of source.split("\n")) {
    const header = LOG_HEADER.exec(line);
    if (header !== null && oneOf(LOG_KINDS, header[3])) {
      close();
      current = { at: header[1], actor: header[2], kind: header[3], text: "" };
      lines = [];
    } else lines.push(line);
  }
  close();
  return entries;
}

// A file an editor or another tool has damaged fails here, by field name,
// rather than turning into an issue with quietly wrong values.
export function parseIssue(source: string, path: string): Issue {
  const { fields, body } = parse(source);
  const need = (key: string): string => {
    const value = text(fields, key);
    if (value === null) throw new Error(`${path}: frontmatter has no ${key}`);
    return value;
  };
  const status = need("status");
  const priority = text(fields, "priority") ?? "none";
  const sensitivity = text(fields, "sensitivity") ?? "sensitive";
  if (!isIssueStatus(status)) throw new Error(`${path}: unknown status "${status}"`);
  if (!isPriority(priority)) throw new Error(`${path}: unknown priority "${priority}"`);
  if (!isSensitivity(sensitivity)) throw new Error(`${path}: unknown sensitivity "${sensitivity}"`);

  const marker = body.indexOf(`\n${LOG_MARKER}`);
  const head = marker === -1 ? body : body.slice(0, marker);
  const tail = marker === -1 ? "" : body.slice(marker + LOG_MARKER.length + 1);
  const description = head.replace(/^# .*\n?/, "").trim();

  return {
    id: need("id"),
    title: need("title"),
    status,
    project: text(fields, "project"),
    priority,
    labels: list(fields, "labels"),
    sensitivity,
    approved: flag(fields, "approved"),
    approved_by: text(fields, "approved_by"),
    approved_at: text(fields, "approved_at"),
    claimed_by: text(fields, "claimed_by"),
    lease_expires_at: text(fields, "lease_expires_at"),
    parent: text(fields, "parent"),
    blocks: list(fields, "blocks"),
    blocked_by: list(fields, "blocked_by"),
    related: list(fields, "related"),
    due: text(fields, "due"),
    acceptance_criteria: list(fields, "acceptance_criteria"),
    links: list(fields, "links"),
    from_thought: text(fields, "from_thought"),
    created_by: text(fields, "created_by") ?? "unknown",
    created: need("created"),
    updated: need("updated"),
    version: integer(fields, "version") ?? 1,
    description,
    log: parseLog(tail),
    extra: [...fields].filter(([key]) => !ISSUE_KEYS.has(key)),
  };
}

export function renderProject(project: Project): string {
  return serialize(
    [
      ["slug", project.slug],
      ["id", project.id],
      ["name", project.name],
      ["status", project.status],
      ["summary", project.summary],
      ["lead", project.lead],
      ["target", project.target],
      ["milestones", project.milestones],
      ["created", project.created],
      ["updated", project.updated],
    ],
    `# ${project.name}\n\n${project.body.trim()}`,
  );
}

function parseProject(source: string, slug: string): Project {
  const { fields, body } = parse(source);
  return {
    slug,
    id: text(fields, "id"),
    name: text(fields, "name") ?? slug,
    status: text(fields, "status") ?? "backlog",
    summary: text(fields, "summary") ?? "",
    lead: text(fields, "lead"),
    target: text(fields, "target"),
    milestones: list(fields, "milestones"),
    created: text(fields, "created") ?? "",
    updated: text(fields, "updated") ?? "",
    body: body.replace(/^# .*\n?/, "").trim(),
  };
}

export function redact(issue: Issue, exposure: Exposure): IssueView {
  if (exposure === "local" || issue.sensitivity === "normal") return issue;
  return {
    id: issue.id,
    project: issue.project,
    status: issue.status,
    sensitivity: "sensitive",
    approved: issue.approved,
    claimed: issue.claimed_by !== null,
    created: issue.created,
    updated: issue.updated,
    redacted: true,
  };
}

const PRIORITY_RANK = new Map<string, number>(PRIORITIES.map((name, index) => [name, index]));

function issueNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

// Most urgent first, then oldest number: the order someone picking work wants.
export function byPriority(a: Issue, b: Issue): number {
  const rank = (PRIORITY_RANK.get(a.priority) ?? 9) - (PRIORITY_RANK.get(b.priority) ?? 9);
  return rank !== 0 ? rank : issueNumber(a.id) - issueNumber(b.id);
}

export interface WorkStoreOptions {
  // Injected so tests can move time past a lease without sleeping.
  now?: () => Date;
}

const LOCK_WAIT_MS = 15000;
const LOCK_STALE_MS = 30000;

export class WorkStore {
  readonly root: string;
  private readonly now: () => Date;
  private depth = 0;
  private messages: string[] = [];

  constructor(root: string, options: WorkStoreOptions = {}) {
    this.root = root;
    this.now = options.now ?? (() => new Date());
  }

  // --- layout ----------------------------------------------------------------

  exists(): boolean {
    return existsSync(join(this.root, "work.json"));
  }

  init(prefix: string, git: boolean): void {
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) {
      throw new WorkError("invalid_input", "prefix must be 2 to 10 capital letters or digits");
    }
    if (this.exists()) throw new WorkError("exists", `${this.root} is already a work directory`);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const dir of [
      "issues",
      "projects",
      "thoughts/inbox",
      "thoughts/notes",
      "thoughts/archive",
    ]) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
    writeFileSync(
      join(this.root, "work.json"),
      `${JSON.stringify({ prefix, next: 1 }, null, 2)}\n`,
    );
    if (git) {
      writeFileSync(join(this.root, ".gitignore"), ".lock/\n.obsidian/workspace*\n.DS_Store\n");
      execFileSync("git", ["-C", this.root, "init", "-q", "-b", "main"]);
      this.commit("chore: create the work directory");
    }
  }

  private requireReady(): void {
    if (!this.exists()) {
      throw new WorkError("not_found", `no work directory at ${this.root}; run krang-work init`);
    }
  }

  private config(): { prefix: string; next: number } {
    this.requireReady();
    const record = parseJsonRecord(readFileSync(join(this.root, "work.json"), "utf8"));
    const prefix = record === null ? null : stringField(record, "prefix");
    const next = record === null ? null : numberField(record, "next");
    if (prefix === null || next === null) throw new Error("work.json is damaged");
    return { prefix, next };
  }

  setNextNumber(next: number): void {
    const config = this.config();
    if (next > config.next)
      this.atomicWrite("work.json", `${JSON.stringify({ ...config, next }, null, 2)}\n`);
  }

  private atomicWrite(relative: string, content: string): void {
    const target = join(this.root, relative);
    const temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  }

  // One lock for the whole store. mkdir either creates the directory or fails,
  // and the filesystem guarantees only one caller gets the first. A holder that
  // died leaves the directory behind, so one older than any real write is
  // removed. Nested calls from the holder pass straight through.
  private locked<T>(message: string, work: () => T): T {
    this.requireReady();
    if (this.depth > 0) {
      this.messages.push(message);
      return work();
    }
    const lock = join(this.root, ".lock");
    const deadline = Date.now() + LOCK_WAIT_MS;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
        } catch {
          // The holder released it between the two calls. Try again.
        }
        if (Date.now() > deadline) throw new Error(`could not lock ${this.root}`);
        Atomics.wait(pause, 0, 0, 5 + Math.floor(Math.random() * 20));
      }
    }
    this.depth = 1;
    this.messages = [message];
    try {
      const result = work();
      this.commit(this.messages[0]);
      return result;
    } finally {
      this.depth = 0;
      rmdirSync(lock);
    }
  }

  // The history. Only when the directory is a git repository, and never fatal:
  // a failed commit leaves the files correct and the next commit picks them up.
  private commit(message: string): void {
    if (!existsSync(join(this.root, ".git"))) return;
    try {
      execFileSync("git", ["-C", this.root, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", this.root, "commit", "-q", "--no-verify", "-m", message], {
        stdio: "ignore",
      });
    } catch {
      // Nothing to commit, or git has no identity configured.
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // --- issues ----------------------------------------------------------------

  private issuePath(id: string): string {
    return join("issues", `${requireIssueId(id)}.md`);
  }

  private read(id: string): Issue {
    const relative = this.issuePath(id);
    const path = join(this.root, relative);
    if (!existsSync(path)) throw new WorkError("not_found", `no issue ${id}`);
    return parseIssue(readFileSync(path, "utf8"), relative);
  }

  private write(issue: Issue): void {
    this.atomicWrite(this.issuePath(issue.id), renderIssue(issue));
  }

  private save(before: Issue, next: Issue): Issue {
    const saved = { ...next, updated: this.stamp(), version: before.version + 1 };
    this.write(saved);
    return saved;
  }

  private leaseLive(issue: Issue): boolean {
    return issue.lease_expires_at !== null && issue.lease_expires_at > this.stamp();
  }

  get(id: string): Issue {
    this.requireReady();
    return this.read(id);
  }

  all(): Issue[] {
    this.requireReady();
    const dir = join(this.root, "issues");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md") && isIssueId(name.slice(0, -3)))
      .map((name) => parseIssue(readFileSync(join(dir, name), "utf8"), join("issues", name)));
  }

  list(filter: ListFilter): Issue[] {
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_LIST_LIMIT) {
      throw new WorkError("invalid_input", `limit must be 1 to ${MAX_LIST_LIMIT}`);
    }
    const query = filter.query === null ? null : filter.query.trim().toLowerCase();
    return this.all()
      .filter((issue) => filter.project === null || issue.project === filter.project)
      .filter((issue) => filter.status === null || issue.status === filter.status)
      .filter((issue) => filter.label === null || issue.labels.includes(filter.label))
      .filter(
        (issue) => !filter.open_only || (issue.status !== "done" && issue.status !== "cancelled"),
      )
      .filter(
        (issue) =>
          query === null ||
          query === "" ||
          `${issue.id} ${issue.title} ${issue.description}`.toLowerCase().includes(query),
      )
      .sort(byPriority)
      .slice(0, filter.limit);
  }

  create(input: CreateInput, fromThought: string | null = null): Issue {
    const actor = requireActor(input.actor);
    const title = requireText(input.title, "title", LIMITS.title).replace(/\s*\n\s*/g, " ");
    const description =
      input.description.trim() === ""
        ? ""
        : requireText(input.description, "description", LIMITS.description);
    const project = input.project === null ? null : requireSlug(input.project, "project");
    const labels = requireLabels(input.labels);
    const criteria = requireCriteria(input.acceptance_criteria);
    return this.locked(`issue: create "${title}"`, () => {
      const config = this.config();
      const id = `${config.prefix}-${config.next}`;
      const at = this.stamp();
      const issue: Issue = {
        id,
        title,
        status: "backlog",
        project,
        priority: input.priority,
        labels,
        sensitivity: input.sensitivity,
        approved: false,
        approved_by: null,
        approved_at: null,
        claimed_by: null,
        lease_expires_at: null,
        parent: null,
        blocks: [],
        blocked_by: [],
        related: [],
        due: null,
        acceptance_criteria: criteria,
        links: [],
        from_thought: fromThought,
        created_by: actor,
        created: at,
        updated: at,
        version: 1,
        description,
        log: [],
        extra: [],
      };
      // The number is spent before the file exists. A crash between the two
      // wastes a number; the other order could hand the same number out twice.
      this.atomicWrite(
        "work.json",
        `${JSON.stringify({ ...config, next: config.next + 1 }, null, 2)}\n`,
      );
      this.write(issue);
      this.messages[0] = `${id}: created by ${actor}`;
      return issue;
    });
  }

  // --- for importers only -------------------------------------------------------

  // Writes an issue exactly as given, keeping its id.
  importIssue(issue: Issue): void {
    requireIssueId(issue.id);
    this.locked(`${issue.id}: imported`, () => this.write(issue));
  }

  // Many writes, one lock and one commit.
  batch<T>(message: string, work: () => T): T {
    return this.locked(message, () => {
      const result = work();
      this.messages[0] = message;
      return result;
    });
  }

  // Projects and documents are written only by an import, so a re-import
  // starts them clean: a project renamed at the source must not leave its old
  // file behind. Issues and thoughts are never removed this way.
  clearImported(): void {
    this.locked("import: clear projects and docs", () => {
      for (const dir of ["projects", "docs"]) {
        const path = join(this.root, dir);
        if (!existsSync(path)) continue;
        for (const name of readdirSync(path)) {
          if (name.endsWith(".md")) rmSync(join(path, name));
        }
      }
    });
  }

  putFile(relative: string, content: string | Uint8Array): void {
    if (relative.startsWith("/") || relative.split("/").includes("..")) {
      throw new WorkError("invalid_input", `"${relative}" is not a path inside the work directory`);
    }
    this.locked(`file: ${relative}`, () => {
      mkdirSync(dirname(join(this.root, relative)), { recursive: true });
      const target = join(this.root, relative);
      const temporary = `${target}.tmp-${process.pid}`;
      writeFileSync(temporary, content);
      renameSync(temporary, target);
    });
  }

  // The agent-facing write. What it cannot do matters more than what it can:
  // it cannot approve, cannot mark done, cannot take an issue (that is claim),
  // and through a cloud reader it cannot touch a sensitive issue at all.
  update(input: UpdateInput, exposure: Exposure): Issue {
    const actor = requireActor(input.actor);
    return this.locked(`${input.id}: updated by ${actor}`, () => {
      const before = this.read(input.id);
      if (exposure === "cloud" && before.sensitivity === "sensitive") {
        throw new WorkError(
          "forbidden",
          "this issue is sensitive; it can only be changed from a local interface",
        );
      }
      if (input.expected_version !== null && input.expected_version !== before.version) {
        throw new WorkError(
          "version_conflict",
          `issue is at version ${before.version}, not ${input.expected_version}; read it again`,
        );
      }
      if (before.status === "done" || before.status === "cancelled") {
        throw new WorkError("invalid_transition", `issue is ${before.status}; it is closed`);
      }

      const next: Issue = { ...before, log: [...before.log] };
      const changed: string[] = [];
      const waiting = before.status === "backlog" || before.status === "todo";
      const holdsClaim =
        before.status === "in_progress" && before.claimed_by === actor && this.leaseLive(before);
      const at = this.stamp();

      const scope =
        input.title !== null || input.description !== null || input.acceptance_criteria !== null;
      const filing = input.project !== null || input.priority !== null || input.labels !== null;
      if ((scope || filing) && !waiting) {
        throw new WorkError(
          "invalid_transition",
          "an issue's definition can only change while it is in backlog or todo",
        );
      }
      // Changing what an approved issue asks for would carry the approval over
      // to work the owner never read. The approval goes; the owner re-approves.
      if (scope && before.approved) {
        next.approved = false;
        next.approved_by = null;
        next.approved_at = null;
        changed.push("approval reset");
      }
      if (input.title !== null) {
        next.title = requireText(input.title, "title", LIMITS.title).replace(/\s*\n\s*/g, " ");
        changed.push("title");
      }
      if (input.description !== null) {
        next.description = requireText(input.description, "description", LIMITS.description);
        changed.push("description");
      }
      if (input.acceptance_criteria !== null) {
        next.acceptance_criteria = requireCriteria(input.acceptance_criteria);
        changed.push("criteria");
      }
      if (input.project !== null) {
        next.project = requireSlug(input.project, "project");
        changed.push("project");
      }
      if (input.priority !== null) {
        next.priority = input.priority;
        changed.push("priority");
      }
      if (input.labels !== null) {
        next.labels = requireLabels(input.labels);
        changed.push("labels");
      }
      if (input.sensitivity !== null && input.sensitivity !== before.sensitivity) {
        // Unreachable from a cloud reader for a sensitive issue (refused
        // above), so a downgrade here is always a local, deliberate act.
        next.sensitivity = input.sensitivity;
        changed.push("sensitivity");
      }
      if (input.add_comment !== null) {
        next.log.push({
          at,
          actor,
          kind: "comment",
          text: requireText(input.add_comment, "comment", LIMITS.entry),
        });
        changed.push("comment");
      }
      if (input.add_evidence.length > 0 || input.handoff !== null) {
        if (!holdsClaim) {
          throw new WorkError(
            "not_claimant",
            "only the actor holding a live claim can add evidence or a handoff",
          );
        }
        for (const item of input.add_evidence) {
          next.log.push({
            at,
            actor,
            kind: "evidence",
            text: requireText(item, "evidence", LIMITS.entry),
          });
        }
        if (input.add_evidence.length > 0) changed.push("evidence");
        if (input.handoff !== null) {
          next.log.push({
            at,
            actor,
            kind: "handoff",
            text: requireText(input.handoff, "handoff", LIMITS.entry),
          });
          changed.push("handoff");
        }
      }

      if (input.status !== null && input.status !== before.status) {
        if (input.status === "in_review") {
          if (!holdsClaim) {
            throw new WorkError(
              "not_claimant",
              "only the actor holding a live claim can send an issue to review",
            );
          }
          if (!next.log.some((entry) => entry.kind === "evidence")) {
            throw new WorkError(
              "invalid_transition",
              "an issue needs at least one evidence entry before review",
            );
          }
        } else if (input.status === "todo") {
          // Releasing a claim. Leaving review is the owner's call, not an agent's.
          if (!holdsClaim) {
            throw new WorkError(
              "not_claimant",
              "only the actor holding a live claim can release it",
            );
          }
          next.claimed_by = null;
          next.lease_expires_at = null;
        } else if (!waiting) {
          throw new WorkError(
            "invalid_transition",
            "only an issue in backlog or todo can be cancelled",
          );
        }
        next.status = input.status;
        changed.push(`${before.status} -> ${input.status}`);
      }

      if (changed.length === 0) return before;
      this.messages[0] = `${before.id}: ${changed.join(", ")} by ${actor}`;
      return this.save(before, next);
    });
  }

  // The precondition is checked and the file rewritten under the store lock,
  // so of any number of callers exactly one finds the issue unclaimed.
  claim(id: string, actorInput: string, leaseSeconds: number, exposure: Exposure): Issue {
    const actor = requireActor(actorInput);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_LEASE_SECONDS) {
      throw new WorkError("invalid_input", `lease_seconds must be 1 to ${MAX_LEASE_SECONDS}`);
    }
    return this.locked(`${id}: claimed by ${actor}`, () => {
      const before = this.read(id);
      if (exposure === "cloud" && before.sensitivity === "sensitive") {
        throw new WorkError(
          "forbidden",
          "this issue is sensitive; it can only be claimed from a local interface",
        );
      }
      if (!before.approved) {
        throw new WorkError("not_approved", "the owner has not approved this issue for work");
      }
      const renewing = before.status === "in_progress" && before.claimed_by === actor;
      const expired = before.status === "in_progress" && !this.leaseLive(before);
      if (before.status === "in_progress" && !renewing && !expired) {
        throw new WorkError(
          "already_claimed",
          `claimed by ${before.claimed_by ?? "another actor"} until ${before.lease_expires_at ?? "unknown"}`,
        );
      }
      if (
        before.status !== "backlog" &&
        before.status !== "todo" &&
        before.status !== "in_progress"
      ) {
        throw new WorkError("not_claimable", `issue is ${before.status}`);
      }
      const open = before.blocked_by.filter((blocker) => {
        try {
          const status = this.read(blocker).status;
          return status !== "done" && status !== "cancelled";
        } catch {
          return false;
        }
      });
      if (open.length > 0) {
        throw new WorkError("blocked", `blocked by ${open.join(", ")}, which are not finished`);
      }
      return this.save(before, {
        ...before,
        status: "in_progress",
        claimed_by: actor,
        lease_expires_at: new Date(this.now().getTime() + leaseSeconds * 1000).toISOString(),
      });
    });
  }

  // --- owner-only operations. The CLI calls these; the MCP server does not. ---

  approve(id: string, ownerInput: string): Issue {
    const owner = requireActor(ownerInput);
    return this.locked(`${id}: approved by ${owner}`, () => {
      const before = this.read(id);
      if (before.status !== "backlog" && before.status !== "todo") {
        throw new WorkError(
          "invalid_transition",
          "only an issue in backlog or todo can be approved",
        );
      }
      if (before.acceptance_criteria.length === 0) {
        throw new WorkError(
          "invalid_transition",
          "an issue needs at least one acceptance criterion before approval",
        );
      }
      return this.save(before, {
        ...before,
        status: "todo",
        approved: true,
        approved_by: owner,
        approved_at: this.stamp(),
      });
    });
  }

  // The owner's verdict on an issue in review. Rejecting returns it to todo
  // with the approval intact, so the same or another agent can claim it again;
  // the evidence stays, because the next attempt should see what was tried.
  review(id: string, ownerInput: string, accept: boolean, note: string | null): Issue {
    const owner = requireActor(ownerInput);
    const verdict = accept ? "accepted" : "rejected";
    return this.locked(`${id}: ${verdict} by ${owner}`, () => {
      const before = this.read(id);
      if (before.status !== "in_review") {
        throw new WorkError("invalid_transition", `issue is ${before.status}, not in review`);
      }
      const log = [...before.log];
      const words = note === null ? "" : `: ${requireText(note, "note", LIMITS.entry)}`;
      log.push({
        at: this.stamp(),
        actor: owner,
        kind: "comment",
        text: `Review ${verdict}${words}`,
      });
      return this.save(before, {
        ...before,
        status: accept ? "done" : "todo",
        claimed_by: null,
        lease_expires_at: null,
        log,
      });
    });
  }

  // Marks an issue done without a review, with the reason on the log. For work
  // that finished somewhere the store cannot see, such as a merged pull request.
  closeByOwner(id: string, ownerInput: string, reason: string): Issue {
    const owner = requireActor(ownerInput);
    return this.locked(`${id}: closed by ${owner}`, () => {
      const before = this.read(id);
      if (before.status === "done" || before.status === "cancelled") return before;
      const log = [...before.log];
      log.push({
        at: this.stamp(),
        actor: owner,
        kind: "comment",
        text: requireText(reason, "reason", LIMITS.entry),
      });
      return this.save(before, {
        ...before,
        status: "done",
        claimed_by: null,
        lease_expires_at: null,
        log,
      });
    });
  }

  prefix(): string {
    return this.config().prefix;
  }

  ownerSet(id: string, ownerInput: string, patch: OwnerPatch): Issue {
    const owner = requireActor(ownerInput);
    return this.locked(`${id}: set by ${owner}`, () => {
      const before = this.read(id);
      const next: Issue = { ...before };
      if (patch.status !== null) {
        next.status = patch.status;
        if (patch.status !== "in_progress" && patch.status !== "in_review") {
          next.claimed_by = null;
          next.lease_expires_at = null;
        }
      }
      if (patch.priority !== null) next.priority = patch.priority;
      if (patch.project !== null) next.project = requireSlug(patch.project, "project");
      if (patch.sensitivity !== null) next.sensitivity = patch.sensitivity;
      if (patch.due !== null) next.due = patch.due;
      if (patch.add_labels.length > 0 || patch.remove_labels.length > 0) {
        next.labels = requireLabels(
          [...before.labels, ...patch.add_labels].filter(
            (label) => !patch.remove_labels.includes(label),
          ),
        );
      }
      if (patch.add_criteria.length > 0) {
        next.acceptance_criteria = requireCriteria([
          ...before.acceptance_criteria,
          ...patch.add_criteria,
        ]);
      }
      return this.save(before, next);
    });
  }

  // --- projects ----------------------------------------------------------------

  projects(): Project[] {
    this.requireReady();
    const dir = join(this.root, "projects");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => parseProject(readFileSync(join(dir, name), "utf8"), name.slice(0, -3)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  writeProject(project: Project): void {
    requireSlug(project.slug, "project slug");
    this.locked(`project ${project.slug}: written`, () =>
      this.atomicWrite(join("projects", `${project.slug}.md`), renderProject(project)),
    );
  }

  // --- thoughts ----------------------------------------------------------------
  //
  // A thought is a file and nothing more: no status, no owner, no approval. It
  // costs one command to write and nothing to ignore. It only becomes work if
  // someone turns it into an issue.

  private thoughtFiles(state: ThoughtState): string[] {
    const dir = join(this.root, "thoughts", state);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  }

  private readThought(state: ThoughtState, name: string): Thought {
    const relative = join("thoughts", state, name);
    const { fields, body } = parse(readFileSync(join(this.root, relative), "utf8"));
    const kind = text(fields, "kind");
    const suggested = text(fields, "suggested_kind");
    return {
      id: text(fields, "id") ?? name.slice(0, 15),
      state,
      file: relative,
      created: text(fields, "created") ?? "",
      tags: list(fields, "tags"),
      kind: kind !== null && isThoughtKind(kind) ? kind : null,
      written_by: text(fields, "written_by") ?? "unknown",
      became: text(fields, "became"),
      suggested_kind: suggested !== null && isThoughtKind(suggested) ? suggested : null,
      suggested_tags: list(fields, "suggested_tags"),
      suggested_by: text(fields, "suggested_by"),
      text: body.trim(),
      extra: [...fields].filter(([key]) => !THOUGHT_KEYS.has(key)),
    };
  }

  private renderThought(thought: Thought): string {
    return serialize(
      [
        ["id", thought.id],
        ["created", thought.created],
        ["tags", thought.tags],
        ["kind", thought.kind],
        ["written_by", thought.written_by],
        ["became", thought.became],
        ["suggested_kind", thought.suggested_kind],
        ["suggested_tags", thought.suggested_tags],
        ["suggested_by", thought.suggested_by],
        ...thought.extra,
      ],
      thought.text,
    );
  }

  thoughts(state: ThoughtState): Thought[] {
    this.requireReady();
    return this.thoughtFiles(state).map((name) => this.readThought(state, name));
  }

  findThought(id: string): Thought {
    this.requireReady();
    if (!THOUGHT_ID.test(id)) throw new WorkError("invalid_input", `"${id}" is not a thought id`);
    for (const state of ["inbox", "notes", "archive"] as const) {
      const name = this.thoughtFiles(state).find((file) => file.startsWith(`${id}-`));
      if (name !== undefined) return this.readThought(state, name);
    }
    throw new WorkError("not_found", `no thought ${id}`);
  }

  jot(body: string, tagInput: string[], writtenBy: string): Thought {
    const words = requireText(body, "thought", LIMITS.thought);
    const tags = requireTags(tagInput);
    const actor = requireActor(writtenBy);
    return this.locked("thought: captured", () => {
      const created = this.stamp();
      const base = created.replace(/[-:]/g, "").slice(0, 15);
      // Two thoughts in one second get distinct ids; the second ends in x2. Not a
      // hyphen: the id is followed by one in the file name, and a lookup by
      // prefix must not find the wrong file.
      let id = base;
      for (let n = 2; this.thoughtTaken(id); n++) id = `${base}x${n}`;
      const firstLine = words.split("\n")[0];
      const name = `${id}-${slugify(firstLine.split(/\s+/).slice(0, 8).join(" "))}.md`;
      const thought: Thought = {
        id,
        state: "inbox",
        file: join("thoughts", "inbox", name),
        created,
        tags,
        kind: null,
        written_by: actor,
        became: null,
        suggested_kind: null,
        suggested_tags: [],
        suggested_by: null,
        text: words,
        extra: [],
      };
      this.atomicWrite(thought.file, this.renderThought(thought));
      this.messages[0] = `thought ${id}: captured`;
      return thought;
    });
  }

  private thoughtTaken(id: string): boolean {
    return (["inbox", "notes", "archive"] as const).some((state) =>
      this.thoughtFiles(state).some((name) => name.startsWith(`${id}-`)),
    );
  }

  private moveThought(thought: Thought, state: ThoughtState, changes: Partial<Thought>): Thought {
    const name = thought.file.slice(thought.file.lastIndexOf("/") + 1);
    const moved: Thought = { ...thought, ...changes, state, file: join("thoughts", state, name) };
    this.atomicWrite(moved.file, this.renderThought(moved));
    if (moved.file !== thought.file) {
      rmSync(join(this.root, thought.file));
    }
    return moved;
  }

  // Keeping a thought is the owner confirming what it is. With no kind given,
  // the suggestion is taken, tags included; with one given, the suggestion is
  // ignored. Either way the suggestion fields are cleared: it has been decided.
  keepThought(id: string, kind: ThoughtKind | null): Thought {
    return this.locked(`thought ${id}: kept`, () => {
      const thought = this.findThought(id);
      const decided = kind ?? thought.suggested_kind ?? "idea";
      const tags =
        kind === null ? [...new Set([...thought.tags, ...thought.suggested_tags])] : thought.tags;
      this.messages[0] = `thought ${id}: kept as ${decided}`;
      return this.moveThought(thought, "notes", {
        kind: decided,
        tags,
        suggested_kind: null,
        suggested_tags: [],
        suggested_by: null,
      });
    });
  }

  suggestThought(id: string, kind: ThoughtKind, tagInput: string[], by: string): Thought {
    const tags = requireTags(tagInput);
    return this.locked(`thought ${id}: suggestion from ${by}`, () => {
      const thought = this.findThought(id);
      if (thought.state !== "inbox") {
        throw new WorkError("invalid_transition", "only a thought in the inbox takes a suggestion");
      }
      return this.moveThought(thought, "inbox", {
        suggested_kind: kind,
        suggested_tags: tags.filter((tag) => !thought.tags.includes(tag)),
        suggested_by: by,
      });
    });
  }

  archiveThought(id: string): Thought {
    return this.locked(`thought ${id}: archived`, () =>
      this.moveThought(this.findThought(id), "archive", {}),
    );
  }

  // A thought that turned out to be work. The issue starts in backlog and
  // unapproved like any other; the thought is archived with a pointer to it.
  thoughtToIssue(id: string, input: Omit<CreateInput, "description">): Issue {
    return this.locked(`thought ${id}: became an issue`, () => {
      const thought = this.findThought(id);
      if (thought.became !== null) {
        throw new WorkError("invalid_transition", `thought ${id} already became ${thought.became}`);
      }
      const issue = this.create({ ...input, description: thought.text }, thought.id);
      this.moveThought(thought, "archive", { became: issue.id });
      this.messages[0] = `${issue.id}: created from thought ${id}`;
      return issue;
    });
  }
}
