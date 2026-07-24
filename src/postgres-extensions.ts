import type { DatabaseService } from './core/database.js';
import type {
  PostgresExtensionCheck,
  PostgresExtensionReport,
  PostgresExtensionRequirement,
} from './postgres-schema/types.js';

type Row = Record<string, unknown>;

export interface PostgresExtensionDiagnostic {
  checkedAt: number;
  requirements: PostgresExtensionReport[];
  installed: Array<{
    name: string;
    version: string;
    schema: string;
  }>;
}

export class PostgresExtensionRequirementError extends Error {
  public readonly code = 'QBXSQL_POSTGRES_EXTENSION_REQUIRED';

  public constructor(public readonly report: PostgresExtensionReport) {
    const failures = report.extensions
      .filter((extension) => extension.state !== 'ready')
      .map((extension) => extension.message);
    super(
      failures.length > 0
        ? `PostgreSQL extension requirements for '${report.resource}' are not satisfied: ${failures.join('; ')}`
        : `PostgreSQL extension requirements for '${report.resource}' are not satisfied.`,
    );
    this.name = 'PostgresExtensionRequirementError';
  }
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value as Row[] : [];
}

function versionParts(version: string): Array<number | string> {
  return version
    .toLowerCase()
    .split(/([0-9]+)/)
    .filter(Boolean)
    .map((part) => (/^[0-9]+$/.test(part) ? Number(part) : part));
}

export function comparePostgresExtensionVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
    if (typeof a === 'number') return 1;
    if (typeof b === 'number') return -1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export class PostgresExtensionRegistry {
  private readonly requirements = new Map<string, PostgresExtensionRequirement[]>();
  private readonly reports = new Map<string, PostgresExtensionReport>();

  public constructor(private readonly database: DatabaseService) {}

  public async check(
    resource: string,
    requirements: readonly PostgresExtensionRequirement[],
  ): Promise<PostgresExtensionReport> {
    const normalized = requirements.map((requirement) => ({ ...requirement }));
    this.requirements.set(resource, normalized);
    const names = normalized.map((requirement) => requirement.name);
    const available = names.length === 0
      ? []
      : rows(await this.database.query(
        `SELECT available.name,
                available.default_version AS "availableVersion",
                installed.extversion AS "installedVersion",
                namespace.nspname AS schema
           FROM pg_catalog.pg_available_extensions available
           LEFT JOIN pg_catalog.pg_extension installed
             ON installed.extname = available.name
           LEFT JOIN pg_catalog.pg_namespace namespace
             ON namespace.oid = installed.extnamespace
          WHERE available.name = ANY($1::text[])
          ORDER BY available.name`,
        [names],
      ));
    const byName = new Map(available.map((row) => [String(row.name), row]));
    const extensions: PostgresExtensionCheck[] = normalized.map((requirement) => {
      const row = byName.get(requirement.name);
      const availableVersion = row?.availableVersion == null
        ? null
        : String(row.availableVersion);
      const installedVersion = row?.installedVersion == null
        ? null
        : String(row.installedVersion);
      const schema = row?.schema == null ? null : String(row.schema);
      if (!row) {
        return {
          ...requirement,
          state: 'unavailable',
          availableVersion,
          installedVersion,
          schema,
          message:
            `extension '${requirement.name}' is not available on this PostgreSQL server; install its server package before enabling it`,
        };
      }
      if (!installedVersion) {
        return {
          ...requirement,
          state: 'not-installed',
          availableVersion,
          installedVersion,
          schema,
          message:
            `extension '${requirement.name}' is available${availableVersion ? ` (${availableVersion})` : ''} but is not enabled in database '${this.database.driver.databaseName ?? 'unknown'}'; run CREATE EXTENSION "${requirement.name}" using operator credentials`,
        };
      }
      if (
        requirement.minimumVersion &&
        comparePostgresExtensionVersions(installedVersion, requirement.minimumVersion) < 0
      ) {
        return {
          ...requirement,
          state: 'version-too-old',
          availableVersion,
          installedVersion,
          schema,
          message:
            `extension '${requirement.name}' is ${installedVersion}, but ${requirement.minimumVersion} or newer is required`,
        };
      }
      return {
        ...requirement,
        state: 'ready',
        availableVersion,
        installedVersion,
        schema,
        message: `extension '${requirement.name}' ${installedVersion} is ready`,
      };
    });
    const report: PostgresExtensionReport = {
      resource,
      satisfied: extensions.every((extension) => extension.state === 'ready'),
      checkedAt: Date.now(),
      extensions,
    };
    this.reports.set(resource, report);
    if (report.satisfied && names.includes('vector')) {
      await this.database.driver.refreshExtensionTypes?.();
    }
    return report;
  }

  public async require(
    resource: string,
    requirements: readonly PostgresExtensionRequirement[],
  ): Promise<PostgresExtensionReport> {
    const report = await this.check(resource, requirements);
    if (!report.satisfied) throw new PostgresExtensionRequirementError(report);
    return report;
  }

  public async diagnostics(): Promise<PostgresExtensionDiagnostic> {
    for (const [resource, requirements] of this.requirements) {
      await this.check(resource, requirements);
    }
    const installed = rows(await this.database.query(
      `SELECT extension.extname AS name,
              extension.extversion AS version,
              namespace.nspname AS schema
         FROM pg_catalog.pg_extension extension
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = extension.extnamespace
        ORDER BY extension.extname`,
    )).map((row) => ({
      name: String(row.name),
      version: String(row.version),
      schema: String(row.schema),
    }));
    return {
      checkedAt: Date.now(),
      requirements: [...this.reports.values()].sort((left, right) =>
        left.resource.localeCompare(right.resource)),
      installed,
    };
  }

  public cachedSummary(): {
    required: number;
    ready: number;
    unsatisfied: number;
    resources: number;
  } {
    const reports = [...this.reports.values()];
    const extensions = reports.flatMap((report) => report.extensions);
    const ready = extensions.filter((extension) => extension.state === 'ready').length;
    return {
      required: extensions.length,
      ready,
      unsatisfied: extensions.length - ready,
      resources: reports.length,
    };
  }
}
