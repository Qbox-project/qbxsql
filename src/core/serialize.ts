export function serializeForRuntime(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return [...value];
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    let result: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const serialized = serializeForRuntime(entry);
      if (result) {
        result[index] = serialized;
      } else if (serialized !== entry) {
        result = value.slice(0, index) as unknown[];
        result[index] = serialized;
      }
    }
    return result ?? value;
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    let result: Record<string, unknown> | null = null;
    for (const [key, entry] of Object.entries(source)) {
      const serialized = serializeForRuntime(entry);
      if (result) {
        result[key] = serialized;
      } else if (serialized !== entry) {
        result = { ...source, [key]: serialized };
      }
    }
    return result ?? value;
  }

  return value;
}
