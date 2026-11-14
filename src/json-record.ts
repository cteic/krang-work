// Turning parsed JSON into typed values without asserting.
//
// A file on disk can be reached by an editor or another machine, and a cast
// makes a malformed field look the same as a valid one until something
// dereferences it. These helpers read one field at a time and return null for
// anything that is not the type asked for.
//
// A Map rather than an index signature, because Object.entries is the one
// conversion that needs no assertion of its own.

export function asRecord(value: unknown): Map<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return new Map<string, unknown>(Object.entries(value));
}

export function parseJsonRecord(text: string): Map<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A string field, or null when absent or any other type. */
export function stringField(record: Map<string, unknown>, key: string): string | null {
  const value = record.get(key);
  return typeof value === "string" ? value : null;
}

export function numberField(record: Map<string, unknown>, key: string): number | null {
  const value = record.get(key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function booleanField(record: Map<string, unknown>, key: string): boolean | null {
  const value = record.get(key);
  return typeof value === "boolean" ? value : null;
}

export function stringArrayField(record: Map<string, unknown>, key: string): string[] | null {
  const value = record.get(key);
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    strings.push(item);
  }
  return strings;
}

export function recordField(
  record: Map<string, unknown>,
  key: string,
): Map<string, unknown> | null {
  return asRecord(record.get(key));
}
