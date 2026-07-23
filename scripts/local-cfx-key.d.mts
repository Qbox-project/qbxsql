export function localCfxKeyPath(repositoryRoot: string): string;
export function readLocalCfxKey(repositoryRoot: string): Promise<string | undefined>;
export function saveLocalCfxKey(repositoryRoot: string, value: string): Promise<string>;
export function promptCfxKey(): Promise<string>;
