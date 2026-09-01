import type { SqliteDatabase } from '../db/adapter.js';
import { openConnection, SqliteVecLoadError, type ConnectionOptions } from '../db/connection.js';
import { KiokukoError } from '../errors.js';
import { JavaScriptVectorSearchBackend } from './javascript-backend.js';
import { createSqliteVecLoader, type SqliteVecLoader } from './sqlite-vec-loader.js';
import { SqliteVecVectorSearchBackend } from './sqlite-vec-backend.js';
import { defaultEmbeddingConfig, readPersistedEmbeddingSettings } from './settings.js';
import type { EmbeddingConfig, VectorSearchBackend } from './types.js';

export type EmbeddingDatabaseOpener = (
  databasePath: string,
  options?: ConnectionOptions,
) => SqliteDatabase | PromiseLike<SqliteDatabase>;

export interface OpenEmbeddingDatabaseOptions {
  readonly config?: EmbeddingConfig;
  readonly openDatabase?: EmbeddingDatabaseOpener;
  readonly createLoader?: () => Promise<SqliteVecLoader | null>;
  readonly backend?: VectorSearchBackend;
}

export interface OpenEmbeddingDatabaseResult {
  readonly database: SqliteDatabase;
  readonly backend: VectorSearchBackend | undefined;
}

/** A forced backend could not be selected; doctor may convert this to a finding. */
export class EmbeddingBackendUnavailableError extends KiokukoError {
  constructor() {
    super('SERVICE_UNAVAILABLE', 'The configured sqlite-vec backend is unavailable');
    this.name = 'EmbeddingBackendUnavailableError';
  }
}

function forcedSqliteVecUnavailable(): never {
  throw new EmbeddingBackendUnavailableError();
}

/**
 * Open one owned database connection and select the backend that is actually
 * usable on that connection. Only the package-owned sqlite-vec loader can
 * create an extension-enabled connection.
 */
export async function openEmbeddingDatabase(
  databasePath: string,
  options: OpenEmbeddingDatabaseOptions,
): Promise<OpenEmbeddingDatabaseResult> {
  const openDatabase = options.openDatabase ?? openConnection;
  if (options.backend !== undefined) {
    return { database: await openDatabase(databasePath), backend: options.backend };
  }
  let config = options.config;
  if (config === undefined) {
    const probe = await openDatabase(databasePath);
    try {
      try {
        config = readPersistedEmbeddingSettings(probe);
      } catch {
        config = defaultEmbeddingConfig();
      }
    } finally {
      probe.close();
    }
  }
  if (config.mode === 'off') {
    return { database: await openDatabase(databasePath), backend: undefined };
  }

  const javascriptBackend = new JavaScriptVectorSearchBackend();
  if (config.vectorBackend === 'javascript') {
    return { database: await openDatabase(databasePath), backend: javascriptBackend };
  }

  const loader = await (options.createLoader ?? createSqliteVecLoader)();
  if (loader === null) {
    if (config.vectorBackend === 'sqlite-vec') forcedSqliteVecUnavailable();
    return { database: await openDatabase(databasePath), backend: javascriptBackend };
  }

  try {
    const database = await openDatabase(databasePath, { sqliteVecLoader: loader });
    return { database, backend: new SqliteVecVectorSearchBackend() };
  } catch (error) {
    if (!(error instanceof SqliteVecLoadError)) throw error;
    if (config.vectorBackend === 'sqlite-vec') forcedSqliteVecUnavailable();
    return { database: await openDatabase(databasePath), backend: javascriptBackend };
  }
}
