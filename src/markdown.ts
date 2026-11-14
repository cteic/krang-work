// Reading and writing the Markdown files the work store keeps.
//
// The frontmatter is a strict subset of YAML that this file both writes and
// reads: `key: scalar`, `key: []`, and `key:` followed by `  - item` lines.
// Free text is written as a JSON string, which is also a valid YAML string, so
// a title with a colon or a quote in it survives a round trip and Obsidian
// still reads the file.

export type FieldValue = string | number | boolean | null | string[];

export interface ParsedFile {
  fields: Map<string, FieldValue>;
  body: string;
}

const BARE = /^[A-Za-z][A-Za-z0-9._/@+-]*$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off"]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/;

function writeScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (TIMESTAMP.test(value)) return value;
  if (BARE.test(value) && !RESERVED.has(value.toLowerCase())) return value;
  return JSON.stringify(value);
}

function readScalar(raw: string): string | number | boolean | null {
  const text = raw.trim();
  if (text === "" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "string" ? parsed : text;
    } catch {
      return text;
    }
  }
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

export function serialize(fields: [string, FieldValue][], body: string): string {
  const lines = ["---"];
  for (const [key, value] of fields) {
    if (value === null) lines.push(`${key}:`);
    else if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${key}: []`);
      else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${writeScalar(item)}`);
      }
    } else lines.push(`${key}: ${writeScalar(value)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${body.replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
}

export function parse(source: string): ParsedFile {
  const fields = new Map<string, FieldValue>();
  if (!source.startsWith("---\n")) return { fields, body: source };
  const end = source.indexOf("\n---\n", 3);
  if (end === -1) return { fields, body: source };
  const lines = source.slice(4, end).split("\n");
  const body = source.slice(end + 5).replace(/^\n+/, "");

  const bareKeys: string[] = [];
  let listKey: string | null = null;
  for (const line of lines) {
    if (listKey !== null && line.startsWith("  - ")) {
      const list = fields.get(listKey);
      const item = readScalar(line.slice(4));
      if (Array.isArray(list)) list.push(item === null ? "" : String(item));
      continue;
    }
    listKey = null;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    if (rest === "[]") fields.set(key, []);
    else if (rest === "") {
      // `key:` alone is either null or the head of a list. It starts as a
      // list; an empty one is turned back into null once the block is read.
      fields.set(key, []);
      bareKeys.push(key);
      listKey = key;
    } else fields.set(key, readScalar(rest));
  }
  for (const key of bareKeys) {
    const value = fields.get(key);
    if (Array.isArray(value) && value.length === 0) fields.set(key, null);
  }
  return { fields, body };
}

export function text(fields: Map<string, FieldValue>, key: string): string | null {
  const value = fields.get(key);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

export function list(fields: Map<string, FieldValue>, key: string): string[] {
  const value = fields.get(key);
  return Array.isArray(value) ? [...value] : [];
}

export function flag(fields: Map<string, FieldValue>, key: string): boolean {
  return fields.get(key) === true;
}

export function integer(fields: Map<string, FieldValue>, key: string): number | null {
  const value = fields.get(key);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// A file name from free text: lower case, hyphens, no more than 60 characters.
export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug === "" ? "untitled" : slug;
}
