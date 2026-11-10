/** Top-level JSON fields for a directed search. A free program is not a table. */

export interface FieldChange {
  field: string;
  newValue: string;
  oldValue: string;
}

export function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function fieldRows(text: string): Array<{ field: string; value: string }> {
  const object = jsonObject(text);
  if (!object) return [];
  return Object.entries(object).map(([field, value]) => ({ field, value: renderValue(value) }));
}

export function fieldChanges(before: string, after: string): FieldChange[] {
  const base = jsonObject(before);
  const next = jsonObject(after);
  if (!base || !next) return [];
  const changes: FieldChange[] = [];
  for (const [field, value] of Object.entries(base)) {
    if (field in next && JSON.stringify(next[field]) !== JSON.stringify(value)) {
      changes.push({ field, oldValue: renderValue(value), newValue: renderValue(next[field]) });
    }
  }
  return changes;
}

export function previewValue(value: string, limit = 24): { full: string; short: string } {
  if (value.length <= limit) return { full: value, short: value };
  return { full: value, short: `${value.slice(0, limit)}…` };
}
