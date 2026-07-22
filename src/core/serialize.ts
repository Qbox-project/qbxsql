export function serializeForRuntime(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return [...value];
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeForRuntime);

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = serializeForRuntime(entry);
    }
    return result;
  }

  return value;
}

