/**
 * Quotes one value for a generated server.cfg. Stripping quotes alone is not
 * enough: a newline in the value ends the directive and everything after it is
 * parsed as further config, so a connection string or key containing one could
 * inject arbitrary directives.
 */
export function configValue(value, label) {
  const text = String(value ?? '');
  if (/[\r\n\0]/.test(text)) {
    throw new Error(`Refusing to write ${label} to server.cfg: value contains a newline.`);
  }
  return text.replaceAll('"', '');
}

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
