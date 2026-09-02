import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeDatabase, type InitOptions } from '../commands/init.js'
import { getGlobalDatabasePath, type PathEnvironment } from '../config/paths.js'
import { openConnection } from '../db/connection.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'
import { openEmbeddingDatabase, type EmbeddingDatabaseOpener } from '../embedding/backend.js'
import { createEmbeddingRuntime } from '../embedding/runtime.js'
import type { EmbeddingConfig, EmbeddingProvider, EmbeddingRuntime, VectorSearchBackend } from '../embedding/types.js'
import { createEmbeddingWorker, type EmbeddingWorker } from '../embedding/worker.js'
import { WriteQueue } from '../server/write-queue.js'
import { DshAgentStateRegistry, type DshAgentIdentity, type DshAgentState } from './agent-state.js'
import { DshContinuationRegistry, type DshContinuationBinding } from './agent-state.js'
import { decideAdapterContinuation, type AdapterDecision } from '../enno-oduno/adapters.js'
import { resolveProjectWorkspace } from '../memory/workspaces.js'

export interface DshRuntimeOptions extends PathEnvironment {
  readonly repositoryRoot: string
  readonly databasePath?: string
  readonly migrationsDirectory?: string
  readonly initializeDatabase?: (options: InitOptions) => unknown | PromiseLike<unknown>
  readonly openDatabase?: EmbeddingDatabaseOpener
  readonly embeddingConfig?: EmbeddingConfig
  readonly embeddingProvider?: EmbeddingProvider
  readonly embeddingBackend?: VectorSearchBackend
  readonly now?: () => string
  /** Automatically persist a local repository binding before startup. */
  readonly autoRegisterRepository?: boolean
}

export type DshDatabaseOperation<T> = (database: SqliteDatabase, runtime: EmbeddingRuntime) => Promise<T> | T

interface RepositoryBinding extends Record<string, unknown> {
  readonly repositoryId: string
  readonly workspace: string
}

interface RuntimeResources {
  readonly database: SqliteDatabase
  readonly embeddingRuntime: EmbeddingRuntime
  readonly worker: EmbeddingWorker | undefined
  readonly queue: WriteQueue<unknown>
  readonly binding: RepositoryBinding
}

function requireRepositoryRoot(root: string): string {
  if (typeof root !== 'string' || root.length === 0 || !resolve(root)) {
    throw new KiokukoError('VALIDATION_ERROR', 'repositoryRoot must be a non-empty path')
  }
  const canonical = realpathSync(root)
  if (!statSync(canonical).isDirectory()) {
    throw new KiokukoError('VALIDATION_ERROR', 'repositoryRoot must be a directory')
  }
  return canonical
}

function findRepositoryBinding(database: SqliteDatabase, repositoryRoot: string): RepositoryBinding {
  const row = database.prepare(`
    SELECT l.repository_id AS repositoryId, r.workspace AS workspace
      FROM repository_locations AS l
      JOIN repositories AS r ON r.repository_id = l.repository_id
     WHERE l.canonical_root = ?
  `).get<RepositoryBinding>(repositoryRoot)
  if (row === undefined) {
    throw new KiokukoError('CONFLICT', 'The repository is not registered with Kiokuko')
  }
  return Object.freeze(row)
}

async function closeResources(resources: {
  database?: SqliteDatabase | undefined
  embeddingRuntime?: EmbeddingRuntime | undefined
  worker?: EmbeddingWorker | undefined
  queue?: WriteQueue<unknown> | undefined
}): Promise<void> {
  const errors: unknown[] = []
  try {
    if (resources.worker !== undefined) await resources.worker.close()
    else await resources.embeddingRuntime?.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await resources.queue?.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    resources.database?.close()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'dsh runtime cleanup failed')
}

/** Own the Kiokuko resources for one dsh process and its agent turns. */
export class DshRuntime {
  readonly #options: DshRuntimeOptions
  readonly #agents = new DshAgentStateRegistry()
  readonly #continuations = new DshContinuationRegistry()
  #initialization: Promise<RuntimeResources> | undefined
  #resources: RuntimeResources | undefined
  #closing = false
  #closed = false
  #closePromise: Promise<void> | undefined
  #activeDatabaseOperations = 0
  #activeDatabaseDrain: Promise<void> | undefined
  #resolveActiveDatabaseDrain: (() => void) | undefined

  constructor(options: DshRuntimeOptions) {
    this.#options = options
  }

  async #initialize(): Promise<RuntimeResources> {
    const configuredRepositoryRoot = requireRepositoryRoot(this.#options.repositoryRoot)
    let repositoryRoot = configuredRepositoryRoot
    const databasePath = this.#options.databasePath ?? getGlobalDatabasePath(this.#options)
    const initialize = this.#options.initializeDatabase ?? initializeDatabase
    let database: SqliteDatabase | undefined
    let embeddingRuntime: EmbeddingRuntime | undefined
    let worker: EmbeddingWorker | undefined
    let queue: WriteQueue<unknown> | undefined
    try {
      await initialize({
        databasePath,
        ...(this.#options.migrationsDirectory === undefined ? {} : { migrationsDirectory: this.#options.migrationsDirectory }),
      })
      const opened = await openEmbeddingDatabase(databasePath, {
        ...(this.#options.embeddingConfig === undefined ? {} : { config: this.#options.embeddingConfig }),
        openDatabase: this.#options.openDatabase ?? openConnection,
        ...(this.#options.embeddingBackend === undefined ? {} : { backend: this.#options.embeddingBackend }),
      })
      database = opened.database
      if (this.#options.autoRegisterRepository === true) {
        const resolved = await resolveProjectWorkspace(database, configuredRepositoryRoot)
        if (resolved !== undefined) repositoryRoot = resolved.repositoryRoot
      }
      const binding = findRepositoryBinding(database, repositoryRoot)
      queue = new WriteQueue<unknown>(64)
      embeddingRuntime = createEmbeddingRuntime(database, this.#options.embeddingConfig, {
        ...(this.#options.embeddingProvider === undefined ? {} : { provider: this.#options.embeddingProvider }),
        ...(opened.backend === undefined ? {} : { backend: opened.backend }),
        enqueueWrite: <T>(operation: () => T | PromiseLike<T>) => queue!.enqueue(operation) as Promise<T>,
      })
      worker = embeddingRuntime.profileId === null ? undefined : createEmbeddingWorker({ runtime: embeddingRuntime })
      const resources = { database, embeddingRuntime, worker, queue, binding } satisfies RuntimeResources
      this.#resources = resources
      worker?.start()
      return resources
    } catch (error) {
      try {
        await closeResources({ database, embeddingRuntime, worker, queue })
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'dsh runtime initialization failed and cleanup also failed')
      }
      throw error
    }
  }

  async start(): Promise<void> {
    if (this.#closed || this.#closing) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh runtime is closed')
    if (this.#resources !== undefined) return
    if (this.#initialization === undefined) {
      this.#initialization = this.#initialize()
    }
    await this.#initialization
  }

  async #requireResources(): Promise<RuntimeResources> {
    if (this.#closing || this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh runtime is closed')
    await this.start()
    if (this.#resources === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'dsh runtime initialized without resources')
    return this.#resources
  }

  async withDatabase<T>(operation: DshDatabaseOperation<T>): Promise<T> {
    if (this.#closing || this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh runtime is closed')
    this.#activeDatabaseOperations += 1
    try {
      const resources = await this.#requireResources()
      return await operation(resources.database, resources.embeddingRuntime)
    } finally {
      this.#activeDatabaseOperations -= 1
      if (this.#activeDatabaseOperations === 0) this.#resolveActiveDatabaseDrain?.()
    }
  }

  async enqueueWrite<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.#closing || this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh runtime is closed')
    const resources = this.#resources ?? await this.#requireResources()
    return resources.queue.enqueue(operation) as Promise<T>
  }

  async openAgent(identity: DshAgentIdentity): Promise<DshAgentState> {
    const resources = await this.#requireResources()
    return this.#agents.open(identity, resources.binding.repositoryId, resources.binding.workspace, this.#options.now?.())
  }

  /** Resume only through the exact dsh session and canonical repository route. */
  async resume(input: { readonly dshSessionId: string; readonly cwd?: string; readonly runId?: string; readonly resumeToken?: string }): Promise<AdapterDecision> {
    const cwd = realpathSync(this.#options.repositoryRoot)
    const runId = input.runId
    if (runId === undefined) throw new KiokukoError('VALIDATION_ERROR', 'runId is required for exact dsh resume')
    const route = await this.withDatabase((database) => {
      const row = database.prepare(`
        SELECT ec.workspace AS workspace, ec.route_epoch AS routeEpoch,
               ec.client_kind AS clientKind, ec.client_session_id AS clientSessionId
        FROM enno_contracts AS ec
        JOIN ledger_runs AS lr ON lr.run_id = ec.run_id AND lr.workspace = ec.workspace
        WHERE ec.run_id = ? AND ec.repository_root = ?
      `).get<{
        workspace: string
        routeEpoch: number
        clientKind: string | null
        clientSessionId: string | null
      }>(runId, cwd)
      if (row === undefined) throw new KiokukoError('CONFLICT', 'The resume run is not registered for this repository')
      return row
    })
    let previousBinding: DshContinuationBinding | undefined
    if (input.resumeToken !== undefined) {
      if (route.clientKind !== 'dsh' || route.clientSessionId !== input.dshSessionId) {
        throw new KiokukoError('CONFLICT', 'resumeToken is not bound to the current dsh session')
      }
      previousBinding = this.#continuations.resolveExact({
        resumeToken: input.resumeToken,
        dshSessionId: input.dshSessionId,
        runId,
        workspace: route.workspace,
      })
      if (route.routeEpoch !== previousBinding.routeEpoch) throw new KiokukoError('CONFLICT', 'resumeToken route epoch is stale')
    }
    const decision = await this.withDatabase((database) => decideAdapterContinuation(database, 'dsh', {
      session_id: input.dshSessionId,
      cwd,
    }, runId))
    if (decision.runId !== null && decision.runId !== runId) throw new KiokukoError('CONFLICT', 'dsh resume resolved a different run')
    if (previousBinding !== undefined && decision.routeEpoch !== previousBinding.routeEpoch) throw new KiokukoError('CONFLICT', 'dsh resume route epoch changed')
    if (decision.resumeToken !== null && decision.runId !== null && decision.routeEpoch !== null && decision.directive !== null) {
      const workspace = await this.withDatabase((database) => {
        const row = database.prepare('SELECT workspace FROM ledger_runs WHERE run_id = ?').get<{ workspace: string }>(decision.runId!)
        if (row === undefined) throw new KiokukoError('CONFLICT', 'The resumed run is not registered')
        return row.workspace
      })
      const binding: DshContinuationBinding = {
        resumeToken: decision.resumeToken,
        dshSessionId: input.dshSessionId,
        runId: decision.runId,
        workspace,
        routeEpoch: decision.routeEpoch,
      }
      this.#continuations.bind(binding)
    }
    return decision
  }

  closeAgent(identity: DshAgentIdentity): boolean {
    return this.#agents.close(identity)
  }

  get continuationCount(): number {
    return this.#continuations.size
  }

  get activeAgentCount(): number {
    return this.#agents.size
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closing = true
    this.#agents.closeAll()
    this.#continuations.clear()
    this.#closePromise = (async () => {
      if (this.#activeDatabaseOperations > 0) {
        this.#activeDatabaseDrain = new Promise<void>((resolve) => { this.#resolveActiveDatabaseDrain = resolve })
        await this.#activeDatabaseDrain
        this.#activeDatabaseDrain = undefined
        this.#resolveActiveDatabaseDrain = undefined
      }
      const resources = this.#resources ?? await this.#initialization?.catch(() => undefined)
      if (resources === undefined) {
        this.#closed = true
        return
      }
      await closeResources(resources)
      this.#resources = undefined
      this.#closed = true
    })()
    return this.#closePromise
  }
}
