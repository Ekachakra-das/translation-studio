export type FlatRecord = Record<string, string>;

export function flattenObject(input: unknown, prefix = ""): FlatRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }

  const out: FlatRecord = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const composedKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[composedKey] = value;
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      Object.assign(out, flattenObject(value, composedKey));
    }
  }
  return out;
}

export function unflattenObject(flat: FlatRecord): Record<string, unknown> {
  const root: Record<string, unknown> = {};

  for (const [flatKey, value] of Object.entries(flat)) {
    const parts = flatKey.split(".");
    let cursor: Record<string, unknown> = root;

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (isLeaf) {
        cursor[part] = value;
      } else {
        if (typeof cursor[part] !== "object" || cursor[part] === null || Array.isArray(cursor[part])) {
          cursor[part] = {};
        }
        cursor = cursor[part] as Record<string, unknown>;
      }
    }
  }

  return root;
}
