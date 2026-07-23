export function createSecretSafeWriter(stream, values) {
  const sensitiveValues = values
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const holdback = Math.max(0, ...sensitiveValues.map((value) => value.length - 1));
  let pending = '';

  const maskSensitiveValues = (value) => {
    let masked = value;
    for (const sensitive of sensitiveValues) {
      masked = masked.replaceAll(sensitive, '*'.repeat(sensitive.length));
    }
    return masked;
  };

  return {
    push(chunk) {
      pending = maskSensitiveValues(pending + chunk.toString());
      const readyLength = Math.max(0, pending.length - holdback);
      if (readyLength > 0) {
        stream.write(pending.slice(0, readyLength));
        pending = pending.slice(readyLength);
      }
    },
    flush() {
      if (pending) stream.write(maskSensitiveValues(pending));
      pending = '';
    },
  };
}
