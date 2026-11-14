import { execFileSync } from "node:child_process";

import { asRecord, stringField } from "./json-record.ts";
import type { WorkStore } from "./work-store.ts";

// "Closes WORK-123" in a merged pull request closes the issue file. A hosted
// tracker does this from a webhook; here it is a command the owner runs, which
// reads merged pull requests through `gh` and marks the issues they name done.
//
// Marking done is the owner's act, so this lives behind the CLI only, and it
// prints what it would do unless told to apply.

const MAGIC = "close[sd]?|fix(?:e[sd])?|resolve[sd]?|complete[sd]?|implement(?:s|ed)?";

// The ids a piece of text closes: a magic word, then one or more ids joined by
// commas or "and". "Refs WORK-9" and a bare "WORK-9" close nothing.
export function closingIds(text: string, prefix: string): string[] {
  const id = `${prefix}-[1-9][0-9]*`;
  const pattern = new RegExp(
    `\\b(?:${MAGIC})\\b:?\\s+((?:${id})(?:(?:\\s*,\\s*|\\s+and\\s+)(?:${id}))*)`,
    "gi",
  );
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    for (const one of match[1].matchAll(new RegExp(id, "gi"))) found.add(one[0].toUpperCase());
  }
  return [...found];
}

export interface MergedPull {
  number: number;
  title: string;
  body: string;
  url: string;
}

export function parsePulls(json: string): MergedPull[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const pulls: MergedPull[] = [];
  for (const item of parsed) {
    const record = asRecord(item);
    const number = record?.get("number");
    if (record === null || typeof number !== "number") continue;
    pulls.push({
      number,
      title: stringField(record, "title") ?? "",
      body: stringField(record, "body") ?? "",
      url: stringField(record, "url") ?? "",
    });
  }
  return pulls;
}

export function mergedPulls(repo: string, limit: number): MergedPull[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`"${repo}" is not an owner/name repository`);
  }
  const json = execFileSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      String(limit),
      "--json",
      "number,title,body,url",
    ],
    { encoding: "utf8" },
  );
  return parsePulls(json);
}

export interface Closure {
  id: string;
  pull: MergedPull;
  outcome: "would close" | "closed" | "already closed" | "no such issue";
}

export function closeFromPulls(
  store: WorkStore,
  prefix: string,
  pulls: MergedPull[],
  owner: string,
  apply: boolean,
): Closure[] {
  const closures: Closure[] = [];
  const seen = new Set<string>();
  for (const pull of pulls) {
    for (const id of closingIds(`${pull.title}\n${pull.body}`, prefix)) {
      if (seen.has(id)) continue;
      seen.add(id);
      let status: string;
      try {
        status = store.get(id).status;
      } catch {
        closures.push({ id, pull, outcome: "no such issue" });
        continue;
      }
      if (status === "done" || status === "cancelled") {
        closures.push({ id, pull, outcome: "already closed" });
        continue;
      }
      if (apply) store.closeByOwner(id, owner, `Closed by merged pull request ${pull.url}`);
      closures.push({ id, pull, outcome: apply ? "closed" : "would close" });
    }
  }
  return closures;
}

// The second signal. A hosted tracker attaches a pull request to an issue
// without any closing word in the pull request itself, and those attachments
// arrive here as links. An open issue whose linked pull request has merged is
// probably finished, but only probably: the link may be a "refs". So these are
// reported as candidates and closed only when the owner asks for them by name.

// A pull request, or a GitHub issue the tracker issue was imported from. A
// GitHub issue closed as completed counts the same as a merged pull request.
const PULL_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)/;

export interface LinkedPull {
  id: string;
  title: string;
  url: string;
}

export function linkedPulls(store: WorkStore, owners: string[]): LinkedPull[] {
  const found: LinkedPull[] = [];
  for (const issue of store.all()) {
    if (issue.status === "done" || issue.status === "cancelled") continue;
    for (const link of issue.links) {
      const match = PULL_URL.exec(link);
      if (match === null || !owners.includes(match[1].toLowerCase())) continue;
      found.push({ id: issue.id, title: issue.title, url: match[0] });
    }
  }
  return found;
}

export type PullState = "merged" | "open" | "closed" | "unknown";

// Reads one answer from `gh`. Kept apart from the decision so the decision can
// be tested without a network.
export function finishedState(kind: string, state: string, reason: string): PullState {
  const value = state.toLowerCase();
  if (kind === "pull") {
    return value === "merged" || value === "open" || value === "closed" ? value : "unknown";
  }
  if (value === "open") return "open";
  if (value !== "closed") return "unknown";
  // Closed as "not planned" or as a duplicate is not finished work.
  return reason.toLowerCase() === "completed" ? "merged" : "closed";
}

export function pullState(url: string): PullState {
  const match = PULL_URL.exec(url);
  if (match === null) return "unknown";
  const pull = match[3] === "pull";
  try {
    const json = execFileSync(
      "gh",
      pull
        ? ["pr", "view", url, "--json", "state"]
        : ["issue", "view", url, "--json", "state,stateReason"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const record = asRecord(JSON.parse(json)) ?? new Map<string, unknown>();
    return finishedState(
      match[3],
      stringField(record, "state") ?? "",
      stringField(record, "stateReason") ?? "",
    );
  } catch {
    return "unknown";
  }
}

export interface Candidate {
  id: string;
  title: string;
  merged: string[];
  unmerged: string[];
}

// An issue is a candidate only when every pull request linked to it has
// merged. One still open means the work is still open.
export function candidates(links: LinkedPull[], state: (url: string) => PullState): Candidate[] {
  const byIssue = new Map<string, Candidate>();
  const cache = new Map<string, PullState>();
  for (const link of links) {
    const known = cache.get(link.url) ?? state(link.url);
    cache.set(link.url, known);
    const entry = byIssue.get(link.id) ?? {
      id: link.id,
      title: link.title,
      merged: [],
      unmerged: [],
    };
    if (known === "merged") entry.merged.push(link.url);
    else entry.unmerged.push(link.url);
    byIssue.set(link.id, entry);
  }
  return [...byIssue.values()].filter(
    (entry) => entry.merged.length > 0 && entry.unmerged.length === 0,
  );
}
