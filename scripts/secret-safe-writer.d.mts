export interface SecretSafeWriter {
  push(chunk: string | Uint8Array): void;
  flush(): void;
}

export function createSecretSafeWriter(
  stream: { write(value: string): unknown },
  values: string[],
): SecretSafeWriter;
