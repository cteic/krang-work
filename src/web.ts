import { createServer } from "node:http";
import type { Server } from "node:http";

import { renderMarkdown } from "./render-markdown.ts";
import { byPriority, isIssueId } from "./work-store.ts";
import type { Issue, IssueStatus, Thought, WorkStore } from "./work-store.ts";

// A read-only view of the work directory in a browser. It serves pages built
// from the files on each request, so there is nothing to keep in step and no
// build. It listens on the loopback address only, accepts GET only, and
// changes nothing: approving and reviewing stay on the command line.

export interface Page {
  status: number;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_LABEL = new Map<IssueStatus, string>([
  ["backlog", "Backlog"],
  ["todo", "Todo"],
  ["in_progress", "In progress"],
  ["in_review", "In review"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
]);

const CSS = `
:root { --bg:#fbfaf8; --panel:#fff; --ink:#1d1c1a; --soft:#6b6862; --line:#e4e1da; --accent:#2f5d50;
  --urgent:#b3261e; --high:#b05a00; --medium:#6b6862; --low:#9a968e; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --panel:#1f1e1c; --ink:#ecebe7; --soft:#a09c94;
  --line:#33312d; --accent:#8fc7b3; --urgent:#ff8a80; --high:#ffb866; --medium:#a09c94; --low:#77736c; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, system-ui, sans-serif; }
header { border-bottom:1px solid var(--line); background:var(--panel); }
header div, main { max-width:1040px; margin:0 auto; padding:0 16px; }
header div { display:flex; gap:20px; align-items:center; height:48px; }
header a { color:var(--soft); text-decoration:none; } header a.home { color:var(--ink); font-weight:600; }
main { padding-top:24px; padding-bottom:64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:15px; margin:32px 0 8px; color:var(--soft); font-weight:600; }
a { color:var(--accent); } p.sub { color:var(--soft); margin:0 0 16px; }
table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
td, th { padding:8px 12px; border-top:1px solid var(--line); text-align:left; vertical-align:top; }
tr:first-child td, tr:first-child th { border-top:0; } th { color:var(--soft); font-weight:500; font-size:13px; }
td.id { white-space:nowrap; font-variant-numeric:tabular-nums; } td.num { text-align:right; font-variant-numeric:tabular-nums; }
.tag { display:inline-block; padding:0 7px; border:1px solid var(--line); border-radius:10px; font-size:12px; color:var(--soft); margin-right:4px; white-space:nowrap; }
.p-urgent { color:var(--urgent); font-weight:600; } .p-high { color:var(--high); } .p-medium { color:var(--medium); } .p-low, .p-none { color:var(--low); }
.cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:12px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; }
.card b { display:block; font-size:24px; } .card span { color:var(--soft); font-size:13px; }
pre { white-space:pre-wrap; word-break:break-word; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; font:14px/1.55 ui-monospace, Menlo, monospace; margin:0; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:16px 0; } dt { color:var(--soft); } dd { margin:0; }
.entry { margin-top:12px; } .who { color:var(--soft); font-size:13px; margin-bottom:4px; }
.md { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:4px 16px; overflow-x:auto; }
.md h3, .md h4, .md h5, .md h6 { font-size:15px; margin:16px 0 4px; } .md p { margin:10px 0; } .md ul, .md ol { padding-left:22px; margin:8px 0; }
.md li.d1 { margin-left:20px; } .md li.d2 { margin-left:40px; } .md li.d3, .md li.d4 { margin-left:60px; }
.md code { font:13px ui-monospace, Menlo, monospace; background:var(--bg); padding:1px 4px; border-radius:4px; }
.md pre { margin:10px 0; background:var(--bg); } .md pre code { padding:0; background:none; }
.md blockquote { margin:10px 0; padding-left:12px; border-left:3px solid var(--line); color:var(--soft); }
.md table { margin:10px 0; } .md hr { border:0; border-top:1px solid var(--line); }
.empty { color:var(--soft); padding:16px; background:var(--panel); border:1px dashed var(--line); border-radius:8px; }
@media (max-width:640px) { .hide-s { display:none; } }
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>
<header><div><a class="home" href="/">Krang work</a><a href="/issues">All issues</a><a href="/thoughts">Thoughts</a></div></header>
<main>${body}</main></body></html>`;
}

function issueRows(issues: Issue[], showProject: boolean): string {
  if (issues.length === 0) return `<div class="empty">Nothing here.</div>`;
  const rows = issues.map((issue) => {
    const flags = [
      issue.approved && issue.status !== "done" ? `<span class="tag">approved</span>` : "",
      issue.claimed_by === null ? "" : `<span class="tag">@${escapeHtml(issue.claimed_by)}</span>`,
      issue.blocked_by.length > 0 ? `<span class="tag">blocked</span>` : "",
      issue.sensitivity === "sensitive" ? `<span class="tag">sensitive</span>` : "",
    ].join("");
    let project = "";
    if (showProject) {
      project =
        issue.project === null
          ? `<td class="hide-s"></td>`
          : `<td class="hide-s"><a href="/project/${escapeHtml(issue.project)}">${escapeHtml(issue.project)}</a></td>`;
    }
    return `<tr><td class="id"><a href="/issue/${escapeHtml(issue.id)}">${escapeHtml(issue.id)}</a></td>
<td>${escapeHtml(issue.title)} ${flags}</td>${project}
<td class="p-${issue.priority}">${issue.priority === "none" ? "" : issue.priority}</td>
<td class="hide-s">${escapeHtml(STATUS_LABEL.get(issue.status) ?? issue.status)}</td></tr>`;
  });
  return `<table>${rows.join("")}</table>`;
}

function isOpen(issue: Issue): boolean {
  return issue.status !== "done" && issue.status !== "cancelled";
}

function home(store: WorkStore): string {
  const issues = store.all();
  const open = issues.filter(isOpen).sort(byPriority);
  const count = (status: IssueStatus) => issues.filter((issue) => issue.status === status).length;
  const moving = open.filter(
    (issue) => issue.status === "in_review" || issue.status === "in_progress",
  );
  const ready = open.filter((issue) => issue.status === "todo");
  const urgent = open
    .filter(
      (issue) =>
        issue.status === "backlog" && (issue.priority === "urgent" || issue.priority === "high"),
    )
    .slice(0, 15);
  const inbox = store.thoughts("inbox").length;

  const cards = [
    [String(count("in_review")), "waiting for your review"],
    [String(count("in_progress")), "in progress"],
    [String(count("todo")), "todo"],
    [String(count("backlog")), "backlog"],
    [String(inbox), "thoughts in the inbox"],
  ].map(([number, label]) => `<div class="card"><b>${number}</b><span>${label}</span></div>`);

  const projects = store.projects().map((project) => {
    const mine = open.filter((issue) => issue.project === project.slug);
    const top = mine.filter(
      (issue) => issue.priority === "urgent" || issue.priority === "high",
    ).length;
    return `<tr><td><a href="/project/${escapeHtml(project.slug)}">${escapeHtml(project.name)}</a></td>
<td class="hide-s">${escapeHtml(project.summary)}</td><td>${escapeHtml(project.status.replace(/_/g, " "))}</td>
<td class="num">${mine.length}</td><td class="num">${top}</td></tr>`;
  });
  const unfiled = open.filter((issue) => issue.project === null).length;

  return layout(
    "Krang work",
    `<h1>Work</h1><p class="sub">${open.length} open issues across ${projects.length} projects.</p>
<div class="cards">${cards.join("")}</div>
<h2>Moving now</h2>${issueRows(moving, true)}
<h2>Todo</h2>${issueRows(ready, true)}
<h2>Urgent and high in the backlog</h2>${issueRows(urgent, true)}
<h2>Projects</h2><table><tr><th>Project</th><th class="hide-s">Summary</th><th>Status</th><th>Open</th><th>Urgent or high</th></tr>${projects.join("")}</table>
${unfiled > 0 ? `<p class="sub" style="margin-top:8px">${unfiled} open issues have no project. <a href="/issues">See all issues.</a></p>` : ""}`,
  );
}

function grouped(issues: Issue[], showProject: boolean): string {
  const order: IssueStatus[] = ["in_review", "in_progress", "todo", "backlog", "done", "cancelled"];
  return order
    .map((status) => {
      const group = issues.filter((issue) => issue.status === status).sort(byPriority);
      if (group.length === 0) return "";
      return `<h2>${STATUS_LABEL.get(status) ?? status} (${group.length})</h2>${issueRows(group, showProject)}`;
    })
    .join("");
}

function projectPage(store: WorkStore, slug: string): Page {
  const project = store.projects().find((candidate) => candidate.slug === slug);
  if (project === undefined) return notFound();
  const issues = store.all().filter((issue) => issue.project === slug);
  const milestones =
    project.milestones.length === 0
      ? ""
      : `<h2>Milestones</h2><table>${project.milestones.map((name) => `<tr><td>${escapeHtml(name)}</td></tr>`).join("")}</table>`;
  return {
    status: 200,
    html: layout(
      project.name,
      `<h1>${escapeHtml(project.name)}</h1><p class="sub">${escapeHtml(project.summary)}</p>
${project.body === "" ? "" : `<div class="md">${renderMarkdown(project.body)}</div>`}${milestones}${grouped(issues, false)}`,
    ),
  };
}

function refs(ids: string[]): string {
  return ids.map((id) => `<a href="/issue/${escapeHtml(id)}">${escapeHtml(id)}</a>`).join(", ");
}

function issuePage(store: WorkStore, id: string): Page {
  if (!isIssueId(id)) return notFound();
  let issue: Issue;
  try {
    issue = store.get(id);
  } catch {
    return notFound();
  }
  const facts: [string, string][] = [
    ["Status", escapeHtml(STATUS_LABEL.get(issue.status) ?? issue.status)],
    ["Priority", escapeHtml(issue.priority)],
    [
      "Project",
      issue.project === null
        ? "none"
        : `<a href="/project/${escapeHtml(issue.project)}">${escapeHtml(issue.project)}</a>`,
    ],
    ["Approved", issue.approved ? `yes, by ${escapeHtml(issue.approved_by ?? "?")}` : "no"],
    ["Sensitivity", escapeHtml(issue.sensitivity)],
  ];
  if (issue.claimed_by !== null) {
    facts.push([
      "Claimed by",
      `${escapeHtml(issue.claimed_by)} until ${escapeHtml(issue.lease_expires_at ?? "?")}`,
    ]);
  }
  if (issue.labels.length > 0) {
    facts.push([
      "Labels",
      issue.labels.map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join(""),
    ]);
  }
  if (issue.parent !== null) facts.push(["Parent", refs([issue.parent])]);
  if (issue.blocked_by.length > 0) facts.push(["Blocked by", refs(issue.blocked_by)]);
  if (issue.blocks.length > 0) facts.push(["Blocks", refs(issue.blocks)]);
  if (issue.related.length > 0) facts.push(["Related", refs(issue.related)]);
  if (issue.due !== null) facts.push(["Due", escapeHtml(issue.due)]);
  facts.push(["File", `issues/${escapeHtml(issue.id)}.md`]);

  const criteria =
    issue.acceptance_criteria.length === 0
      ? ""
      : `<h2>Acceptance criteria</h2><table>${issue.acceptance_criteria.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`).join("")}</table>`;
  const log =
    issue.log.length === 0
      ? ""
      : `<h2>Log</h2>${issue.log
          .map(
            (entry) =>
              `<div class="entry"><div class="who">${escapeHtml(entry.at.slice(0, 16).replace("T", " "))} · ${escapeHtml(entry.actor)} · ${entry.kind}</div><div class="md">${renderMarkdown(entry.text)}</div></div>`,
          )
          .join("")}`;
  return {
    status: 200,
    html: layout(
      `${issue.id} ${issue.title}`,
      `<p class="sub">${escapeHtml(issue.id)}</p><h1>${escapeHtml(issue.title)}</h1>
<dl>${facts.map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`).join("")}</dl>
${issue.description === "" ? "" : `<div class="md">${renderMarkdown(issue.description)}</div>`}${criteria}${log}`,
    ),
  };
}

function suggestion(thought: Thought): string {
  if (thought.suggested_kind === null) return "";
  const tags = thought.suggested_tags.map((tag) => ` #${escapeHtml(tag)}`).join("");
  return `<div class="who">suggested by ${escapeHtml(thought.suggested_by ?? "a model")}: ${thought.suggested_kind}${tags}</div>`;
}

function thoughtsPage(store: WorkStore): string {
  const now = Date.now();
  const inbox = store.thoughts("inbox");
  const rows = inbox.map((thought) => {
    const days = Math.max(0, Math.floor((now - Date.parse(thought.created)) / 86400000));
    return `<tr><td class="id">${escapeHtml(thought.id)}</td><td>${escapeHtml(thought.text)}
${thought.tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}${suggestion(thought)}</td>
<td class="num">${days === 0 ? "today" : `${days}d`}</td></tr>`;
  });
  const kept = store.thoughts("notes");
  const keptRows = kept.map(
    (thought) =>
      `<tr><td class="id">${escapeHtml(thought.kind ?? "")}</td><td>${escapeHtml(thought.text)}</td></tr>`,
  );
  return layout(
    "Thoughts",
    `<h1>Thoughts</h1><p class="sub">Oldest first. Keep, turn into an issue, or archive with <code>krang-work thoughts</code>.</p>
<h2>Inbox (${inbox.length})</h2>${rows.length === 0 ? `<div class="empty">The inbox is empty.</div>` : `<table>${rows.join("")}</table>`}
<h2>Kept (${kept.length})</h2>${keptRows.length === 0 ? `<div class="empty">Nothing kept yet.</div>` : `<table>${keptRows.join("")}</table>`}`,
  );
}

function notFound(): Page {
  return {
    status: 404,
    html: layout("Not found", `<h1>Not found</h1><p class="sub"><a href="/">Back to work.</a></p>`),
  };
}

export function render(store: WorkStore, path: string): Page {
  if (path === "/") return { status: 200, html: home(store) };
  if (path === "/issues") {
    return {
      status: 200,
      html: layout("All issues", `<h1>All issues</h1>${grouped(store.all(), true)}`),
    };
  }
  if (path === "/thoughts") return { status: 200, html: thoughtsPage(store) };
  if (path.startsWith("/project/")) return projectPage(store, decodeURIComponent(path.slice(9)));
  if (path.startsWith("/issue/")) return issuePage(store, decodeURIComponent(path.slice(7)));
  return notFound();
}

export function startServer(store: WorkStore, port: number): Server {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer((request, response) => {
    const send = (status: number, html: string) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      response.end(html);
    };
    // A page on another site cannot reach this server by pointing a hostname
    // at 127.0.0.1: the Host header would not be one of these two.
    if (!allowed.has(request.headers.host ?? ""))
      return send(403, layout("Forbidden", "<h1>Forbidden</h1>"));
    if (request.method !== "GET")
      return send(405, layout("Read only", "<h1>This view is read only.</h1>"));
    try {
      const page = render(store, new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      send(page.status, page.html);
    } catch (error) {
      console.error("[krang-work] page failed:", error);
      send(500, layout("Error", '<h1>That page failed.</h1><p class="sub">See the terminal.</p>'));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
