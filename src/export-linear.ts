import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asRecord, recordField, stringField } from "./json-record.ts";

// A read-only copy of a Linear workspace as JSON files, one array per entity.
// import-linear.ts reads what this writes. It sends queries and never a
// mutation, so nothing at Linear changes.
//
// The key comes from LINEAR_API_KEY, or from the macOS keychain item
// (account "linear", service "krang-linear-export"). It is never printed.

const ENDPOINT = "https://api.linear.app/graphql";
const UPLOADS = /https:\/\/uploads\.linear\.app\/[^\s"\\)<>]+/g;

function readKey(): string {
  const fromEnv = process.env.LINEAR_API_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", "linear", "-s", "krang-linear-export", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error(
      "No Linear key. Set LINEAR_API_KEY, or add a keychain item with account linear and service krang-linear-export.",
    );
  }
}

async function query(
  key: string,
  text: string,
  variables: Record<string, unknown>,
): Promise<Map<string, unknown>> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: text, variables }),
    });
    const raw = await response.text();
    if (response.status === 429 || raw.includes("RATELIMITED")) {
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
      continue;
    }
    let body: Map<string, unknown> | null = null;
    try {
      body = asRecord(JSON.parse(raw));
    } catch {
      body = null;
    }
    const data = body === null ? null : recordField(body, "data");
    if (!response.ok || data === null || body?.has("errors") === true) {
      throw new Error(`Linear returned ${response.status}: ${raw.slice(0, 400)}`);
    }
    return data;
  }
  throw new Error("Linear rate-limited the export five times; try again later");
}

async function all(key: string, name: string, fields: string, args: string): Promise<unknown[]> {
  const nodes: unknown[] = [];
  let after: string | null = null;
  for (;;) {
    const data = await query(
      key,
      `query($after: String) { ${name}(first: 50, after: $after${args}) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    const connection = recordField(data, name);
    const page = connection?.get("nodes");
    if (connection === null || !Array.isArray(page)) throw new Error(`Linear sent no ${name}`);
    nodes.push(...page);
    const info = recordField(connection, "pageInfo");
    if (info === null || info.get("hasNextPage") !== true) return nodes;
    after = stringField(info, "endCursor");
  }
}

const USER = "id name displayName";
const ARCHIVED = ", includeArchived: true";

// [entity, fields, extra arguments]. Top-level connections only: nesting
// comments under issues multiplies the query cost past Linear's limit.
const SETS: [string, string, string][] = [
  ["teams", "id key name description", ""],
  ["users", `${USER} active`, ARCHIVED],
  ["workflowStates", "id name type position team { key }", ""],
  ["issueLabels", "id name color description isGroup parent { id name } team { key }", ARCHIVED],
  [
    "projects",
    `id name slugId description content url priority health progress startDate targetDate
     createdAt updatedAt startedAt completedAt canceledAt archivedAt
     status { name type } lead { ${USER} } teams { nodes { key } } labels { nodes { name } }`,
    ARCHIVED,
  ],
  [
    "projectMilestones",
    "id name description targetDate sortOrder createdAt project { id name }",
    "",
  ],
  [
    "projectUpdates",
    `id body health url createdAt updatedAt user { ${USER} } project { id name }`,
    ARCHIVED,
  ],
  [
    "documents",
    `id title content url slugId createdAt updatedAt creator { ${USER} } project { id name } issue { identifier }`,
    ARCHIVED,
  ],
  [
    "issues",
    `id identifier number title description url priority priorityLabel estimate dueDate sortOrder branchName
     createdAt updatedAt startedAt completedAt canceledAt archivedAt autoClosedAt trashed
     state { name type } team { key } project { id name } projectMilestone { id name } cycle { number }
     parent { identifier } creator { ${USER} } assignee { ${USER} } labels { nodes { name } }`,
    ARCHIVED,
  ],
  [
    "comments",
    `id body url createdAt updatedAt editedAt resolvedAt quotedText
     user { ${USER} } botActor { name } parent { id } issue { identifier } projectUpdate { id }`,
    ARCHIVED,
  ],
  [
    "issueRelations",
    "id type createdAt issue { identifier } relatedIssue { identifier }",
    ARCHIVED,
  ],
  [
    "attachments",
    `id title subtitle url sourceType metadata createdAt creator { ${USER} } issue { identifier }`,
    ARCHIVED,
  ],
];

export interface ExportReport {
  dir: string;
  counts: Record<string, number>;
  assets: number;
  assetsFailed: number;
}

export async function exportLinear(dir: string): Promise<ExportReport> {
  const key = readKey();
  mkdirSync(join(dir, "assets"), { recursive: true, mode: 0o700 });
  const counts: Record<string, number> = {};
  let everything = "";
  for (const [name, fields, args] of SETS) {
    const nodes = await all(key, name, fields, args);
    counts[name] = nodes.length;
    const text = JSON.stringify(nodes, null, 2);
    everything += text;
    writeFileSync(join(dir, `${name}.json`), text);
  }

  // Uploaded files are referenced by URL and need the key to fetch.
  const urls = [...new Set(everything.match(UPLOADS) ?? [])];
  const assets: Record<string, string>[] = [];
  let failed = 0;
  for (const url of urls) {
    const name = url.replace("https://uploads.linear.app/", "").replace(/[^A-Za-z0-9._-]/g, "_");
    const response = await fetch(url, { headers: { Authorization: key } });
    if (!response.ok) {
      failed++;
      assets.push({ url, failed: `HTTP ${response.status}` });
      continue;
    }
    writeFileSync(join(dir, "assets", name), new Uint8Array(await response.arrayBuffer()));
    assets.push({ url, file: `assets/${name}`, type: response.headers.get("content-type") ?? "" });
  }
  writeFileSync(join(dir, "assets.json"), JSON.stringify(assets, null, 2));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ exportedAt: new Date().toISOString(), counts }, null, 2),
  );
  return { dir, counts, assets: urls.length - failed, assetsFailed: failed };
}
