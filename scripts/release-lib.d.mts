export function publicManifestVersion(qbxsqlVersion: string): string;
export function releaseFiles(): Promise<{ core: string[] }>;
export function deterministicZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer;
export function validateDocumentationLinks(entries: Map<string, Buffer>): void;
