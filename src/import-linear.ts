import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asRecord, recordField, stringField } from "./json-record.ts";
import { serialize, slugify } from "./markdown.ts";
import { WorkError, isIssueId } from "./work-store.ts";
import type { Issue, IssueStatus, LogEntry, Priority, WorkStore } from "./work-store.ts";

// Turns a Linear export (the JSON files written by the export script: one array
// per entity) into work-store files. It reads the export and writes the store;
// it never talks to Linear.
//
// Every issue keeps its Linear identifier, so a commit or pull request that
// says "Closes WORK-123" still points at the right file.

type Row = Map<string, unknown>;

function rows(dir: string, name: string): Row[] {
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new WorkError("invalid_input", `${name}.json is not an array`);
  const result: Row[] = [];
  for (const item of parsed) {
    const record = asRecord(item);
    if (record !== null) result.push(record);
  }
  return result;
}

function nested(row: Row, key: string, field: string): string | null {
  const inner = recordField(row, key);
  return inner === null ? null : stringField(inner, field);
}

function names(row: Row, key: string, field: string): string[] {
  const inner = recordField(row, key);
  const nodes = inner?.get("nodes");
  if (!Array.isArray(nodes)) return [];
  const result: string[] = [];
  for (const node of nodes) {
    const record = asRecord(node);
    const value = record === null ? null : stringField(record, field);
    if (value !== null) result.push(value);
  }
  return result;
}

const STATUS_BY_TYPE = new Map<string, IssueStatus>([
  ["triage", "backlog"],
  ["backlog", "backlog"],
  ["unstarted", "todo"],
  ["started", "in_progress"],
  ["completed", "done"],
  ["canceled", "cancelled"],
  ["duplicate", "cancelled"],
]);

const PRIORITY_BY_LABEL = new Map<string, Priority>([
  ["Urgent", "urgent"],
  ["High", "high"],
  ["Medium", "medium"],
  ["Low", "low"],
]);

function statusOf(row: Row): IssueStatus {
  // "In Review" is a started state in Linear; here it is its own status.
  if (nested(row, "state", "name") === "In Review") return "in_review";
  return STATUS_BY_TYPE.get(nested(row, "state", "type") ?? "") ?? "backlog";
}

// An actor is one token here. "Jane Doe" becomes "Jane-Doe".
function actorName(value: string | null): string {
  const cleaned = (value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._@-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "unknown" : cleaned.slice(0, 64);
}

const EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["application/pdf", ".pdf"],
]);

export interface ImportReport {
  issues: number;
  projects: number;
  documents: number;
  comments: number;
  relations: number;
  assets: number;
  byStatus: Record<string, number>;
  warnings: string[];
}

// `replace` re-imports over an earlier import. The caller is responsible for
// checking that nothing local would be lost; see refreshIsSafe in the CLI.
export function importLinear(store: WorkStore, dir: string, replace = false): ImportReport {
  if (!existsSync(join(dir, "issues.json"))) {
    throw new WorkError("not_found", `${dir} has no issues.json; is it a Linear export?`);
  }
  if (!replace && store.all().length > 0) {
    throw new WorkError(
      "exists",
      "the work directory already has issues; import into an empty one, or use refresh-linear",
    );
  }
  const warnings: string[] = [];

  // Uploaded files: copied in, and every reference to them rewritten to the
  // copy, so the text no longer depends on a URL that needs a Linear login.
  const assetPaths = new Map<string, string>();
  const assetFiles: { from: string; to: string }[] = [];
  for (const row of rows(dir, "assets")) {
    const url = stringField(row, "url");
    const file = stringField(row, "file");
    if (url === null || file === null) {
      warnings.push(`asset not downloaded: ${url ?? "unknown"}`);
      continue;
    }
    const base = file.slice(file.lastIndexOf("/") + 1).slice(-36);
    const to = `assets/${base}${EXTENSIONS.get(stringField(row, "type") ?? "") ?? ""}`;
    assetPaths.set(url, to);
    assetFiles.push({ from: join(dir, file), to });
  }
  const localise = (markdown: string, depth: string): string => {
    let result = markdown;
    for (const [url, to] of assetPaths) result = result.split(url).join(`${depth}${to}`);
    return result;
  };

  const projectSlugs = new Map<string, string>();
  const projectRows = rows(dir, "projects");
  for (const row of projectRows) {
    const id = stringField(row, "id");
    const name = stringField(row, "name");
    if (id === null || name === null) continue;
    let slug = slugify(name);
    while ([...projectSlugs.values()].includes(slug)) slug = `${slug}-2`;
    projectSlugs.set(id, slug);
  }

  const milestones = new Map<string, string[]>();
  for (const row of rows(dir, "projectMilestones")) {
    const project = nested(row, "project", "id");
    const name = stringField(row, "name");
    if (project === null || name === null) continue;
    const target = stringField(row, "targetDate");
    milestones.set(project, [
      ...(milestones.get(project) ?? []),
      target === null ? name : `${name} (${target})`,
    ]);
  }

  const comments = new Map<string, LogEntry[]>();
  let commentCount = 0;
  for (const row of rows(dir, "comments")) {
    const issue = nested(row, "issue", "identifier");
    const body = stringField(row, "body");
    const at = stringField(row, "createdAt");
    if (issue === null || body === null || at === null || body.trim() === "") continue;
    const actor = actorName(nested(row, "user", "name") ?? nested(row, "botActor", "name"));
    comments.set(issue, [
      ...(comments.get(issue) ?? []),
      { at, actor, kind: "comment", text: localise(body, "../") },
    ]);
    commentCount++;
  }

  const blocks = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  const related = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    const current = map.get(key) ?? [];
    if (!current.includes(value)) map.set(key, [...current, value]);
  };
  let relationCount = 0;
  for (const row of rows(dir, "issueRelations")) {
    const from = nested(row, "issue", "identifier");
    const to = nested(row, "relatedIssue", "identifier");
    const type = stringField(row, "type");
    if (from === null || to === null || type === null) continue;
    if (type === "blocks") {
      add(blocks, from, to);
      add(blockedBy, to, from);
    } else {
      // "related" and "duplicate" both become a plain two-way link.
      add(related, from, to);
      add(related, to, from);
      if (type !== "related") warnings.push(`${from} ${type} ${to}: kept as related`);
    }
    relationCount++;
  }

  const links = new Map<string, string[]>();
  for (const row of rows(dir, "attachments")) {
    const issue = nested(row, "issue", "identifier");
    const url = stringField(row, "url");
    if (issue !== null && url !== null) add(links, issue, url);
  }

  const byStatus: Record<string, number> = {};
  let highest = 0;
  const issues: Issue[] = [];
  for (const row of rows(dir, "issues")) {
    const id = stringField(row, "identifier");
    const title = stringField(row, "title");
    const created = stringField(row, "createdAt");
    if (id === null || !isIssueId(id) || title === null || created === null) {
      warnings.push(`skipped an issue with no usable id or title: ${id ?? "unknown"}`);
      continue;
    }
    const status = statusOf(row);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    highest = Math.max(highest, Number(id.slice(id.lastIndexOf("-") + 1)));
    const projectId = nested(row, "project", "id");
    const url = stringField(row, "url");
    issues.push({
      id,
      title: title.replace(/\s*\n\s*/g, " ").trim(),
      status,
      project: projectId === null ? null : (projectSlugs.get(projectId) ?? null),
      priority: PRIORITY_BY_LABEL.get(stringField(row, "priorityLabel") ?? "") ?? "none",
      labels: names(row, "labels", "name"),
      // It has been on a hosted tracker until now, so it is not secret from
      // one. New issues default to sensitive; imported ones start normal.
      sensitivity: "normal",
      approved: false,
      approved_by: null,
      approved_at: null,
      claimed_by: null,
      lease_expires_at: null,
      parent: nested(row, "parent", "identifier"),
      blocks: blocks.get(id) ?? [],
      blocked_by: blockedBy.get(id) ?? [],
      related: related.get(id) ?? [],
      due: stringField(row, "dueDate"),
      acceptance_criteria: [],
      links: [...(url === null ? [] : [url]), ...(links.get(id) ?? [])],
      from_thought: null,
      created_by: actorName(nested(row, "creator", "name")),
      created,
      updated: stringField(row, "updatedAt") ?? created,
      version: 1,
      description: localise(stringField(row, "description") ?? "", "../"),
      log: (comments.get(id) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
      extra: [],
    });
  }

  const documents = rows(dir, "documents");
  store.batch(`import: ${issues.length} issues from a Linear export`, () => {
    if (replace) store.clearImported();
    for (const asset of assetFiles) store.putFile(asset.to, readFileSync(asset.from));
    for (const row of projectRows) {
      const id = stringField(row, "id");
      const slug = id === null ? undefined : projectSlugs.get(id);
      if (id === null || slug === undefined) continue;
      const url = stringField(row, "url");
      const content = localise(stringField(row, "content") ?? "", "../");
      store.writeProject({
        slug,
        id: null,
        name: stringField(row, "name") ?? slug,
        status: slugify(nested(row, "status", "name") ?? "backlog").replace(/-/g, "_"),
        summary: stringField(row, "description") ?? "",
        lead: nested(row, "lead", "name"),
        target: stringField(row, "targetDate"),
        milestones: milestones.get(id) ?? [],
        created: stringField(row, "createdAt") ?? "",
        updated: stringField(row, "updatedAt") ?? "",
        body: url === null ? content : `${content}\n\nImported from ${url}`,
      });
    }
    for (const issue of issues) store.importIssue(issue);
    for (const row of documents) {
      const title = stringField(row, "title") ?? "Untitled";
      const projectId = nested(row, "project", "id");
      store.putFile(
        `docs/${slugify(title)}.md`,
        serialize(
          [
            ["title", title],
            ["project", projectId === null ? null : (projectSlugs.get(projectId) ?? null)],
            ["created", stringField(row, "createdAt")],
            ["updated", stringField(row, "updatedAt")],
            ["links", [stringField(row, "url") ?? ""].filter((link) => link !== "")],
          ],
          `# ${title}\n\n${localise(stringField(row, "content") ?? "", "../")}`,
        ),
      );
    }
    store.setNextNumber(highest + 1);
  });

  return {
    issues: issues.length,
    projects: projectSlugs.size,
    documents: documents.length,
    comments: commentCount,
    relations: relationCount,
    assets: assetFiles.length,
    byStatus,
    warnings,
  };
}
