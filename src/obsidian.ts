import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asRecord, parseJsonRecord, stringField } from "./json-record.ts";
import { serialize } from "./markdown.ts";
import { WorkError } from "./work-store.ts";
import type { Thought } from "./work-store.ts";

// Sending a kept thought to an Obsidian vault that runs the Discourse Graphs
// plugin, as a proposal for the person to confirm there.
//
// What is written is a plain note. It never carries the plugin's `nodeTypeId`,
// so the plugin does not treat it as a node. The thought's line ends with the
// candidate tag the vault itself defines for that kind of node (`clm-candidate`
// for a claim, in the default setup), which is what makes the plugin offer to
// turn the line into a node. Confirming is a click by the person, in Obsidian.
//
// Relations are not written. The plugin keeps them in one `relations.json`
// that it rewrites whole, so a second writer would lose changes.

const PLUGIN_DATA = join(".obsidian", "plugins", "discourse-graphs", "data.json");
export const PROPOSED_FOLDER = "Krang Proposed";

export interface VaultNodeType {
  name: string;
  tag: string;
}

// Only the node types are read. The same file can hold the plugin's sync
// credentials, and nothing here looks at them.
export function readNodeTypes(vault: string): VaultNodeType[] {
  if (!existsSync(join(vault, ".obsidian"))) {
    throw new WorkError("not_found", `${vault} is not an Obsidian vault (no .obsidian folder)`);
  }
  const path = join(vault, PLUGIN_DATA);
  if (!existsSync(path)) return [];
  const record = parseJsonRecord(readFileSync(path, "utf8"));
  const raw = record?.get("nodeTypes");
  if (!Array.isArray(raw)) return [];
  const types: VaultNodeType[] = [];
  for (const item of raw) {
    const type = asRecord(item);
    const name = type === null ? null : stringField(type, "name");
    if (type === null || name === null) continue;
    types.push({ name, tag: (stringField(type, "tag") ?? "").trim().replace(/^#/, "") });
  }
  return types;
}

// The vault's own tag for this kind, or null when it defines none. An "idea"
// has no node type in the default setup, so it goes over as a plain note.
export function candidateTag(kind: string | null, types: VaultNodeType[]): string | null {
  if (kind === null) return null;
  const type = types.find((candidate) => candidate.name.toLowerCase() === kind.toLowerCase());
  return type === undefined || type.tag === "" ? null : type.tag;
}

function fileTitle(text: string): string {
  const title = text
    .split("\n")[0]
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return title === "" ? "Untitled" : title;
}

export function proposalNote(thought: Thought, tag: string | null, proposedAt: string): string {
  const [first, ...rest] = thought.text.split("\n");
  const line = tag === null ? first : `${first} #${tag}`;
  return serialize(
    [
      ["status", "proposed"],
      ["proposed_by", "krang"],
      ["proposed_at", proposedAt],
      ["krang_thought", thought.id],
      ["written_by", thought.written_by],
      ["tags", thought.tags],
    ],
    [line, ...rest].join("\n"),
  );
}

export interface Sent {
  path: string;
  tag: string | null;
}

export function sendToVault(thought: Thought, vault: string, proposedAt: string): Sent {
  const tag = candidateTag(thought.kind, readNodeTypes(vault));
  const folder = join(vault, PROPOSED_FOLDER);
  const relative = join(PROPOSED_FOLDER, `${fileTitle(thought.text)}.md`);
  const path = join(vault, relative);
  if (existsSync(path)) {
    throw new WorkError("exists", `${relative} is already in the vault; nothing was overwritten`);
  }
  mkdirSync(folder, { recursive: true });
  // "wx" fails if the file appeared since the check, so nothing is overwritten.
  writeFileSync(path, proposalNote(thought, tag, proposedAt), { flag: "wx" });
  return { path: relative, tag };
}
