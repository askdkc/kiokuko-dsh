/** Internal host contract. Descriptors are trusted local code, never fetched Skills. */
export const CORE_CONTRACT_VERSION = 1 as const
export interface ModuleResource {
  readonly name: string
  readonly relativePath: string
  readonly load: () => Promise<string>
}
export interface ModuleBinding {
  readonly moduleId: string
  readonly version: number
  readonly requestId: string
  readonly sessionId: string
  readonly workspace: string
}
export interface ModuleHandle {
  /** Synchronous: stop accepting new work, retaining any host safety fences. */
  stopIngress(): void
  /** Reconcile/finish in-flight work before releasing shared resources. */
  drain(): Promise<void>
  dispose(): Promise<void>
}
export interface ModuleMountScope<Host> {
  readonly host: Host
  /** Register each acquired resource immediately, including before a partial mount fails. */
  defer(cleanup: () => void | Promise<void>): void
}
export interface DshModule<Host = unknown> {
  readonly id: string
  readonly coreVersion: number
  readonly requires: readonly string[]
  readonly resources?: readonly ModuleResource[]
  /** Host-owned configuration validation, run for every module before any mount. */
  readonly configure: (value: unknown) => unknown
  readonly conflicts?: readonly string[]
  readonly mount?: (scope: ModuleMountScope<Host>, configuration: unknown) => Promise<ModuleHandle>
}
export interface ModuleRegistration<Host> {
  readonly module: DshModule<Host>
  readonly configuration?: unknown
}

function identifier(value: string): boolean { return /^[a-z][a-z0-9-]{0,63}$/.test(value) }
async function cleanups(operations: readonly (() => void | Promise<void>)[], failures: unknown[]): Promise<void> {
  for (const operation of [...operations].reverse()) {
    try { await operation() } catch (error) { failures.push(error) }
  }
}
function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/** One lifecycle owner; the registry adds constraints and never grants native permissions. */
export class DshModules<Host> {
  readonly #entries: readonly { module: DshModule<Host>; configuration: unknown }[]
  readonly #mounted: { id: string; handle: ModuleHandle; cleanup: (() => void | Promise<void>)[] }[] = []
  readonly #resources: readonly ModuleResource[]
  #state: 'new' | 'mounting' | 'active' | 'stopping' | 'disposed' | 'failed' = 'new'
  #start?: Promise<void>
  #shutdown?: Promise<void>
  readonly #stopFailures: unknown[] = []
  #rollbackFailed = false
  constructor(registrations: readonly ModuleRegistration<Host>[], capabilities: readonly string[]) {
    const ids = new Set<string>(), resources = new Set<string>()
    // Validate the whole composition before configuration can acquire anything.
    for (const { module } of registrations) {
      if (!identifier(module.id) || ids.has(module.id)) throw new Error(`Invalid or duplicate module ID: ${module.id}`)
      if (module.coreVersion !== CORE_CONTRACT_VERSION) throw new Error(`Incompatible core contract: ${module.id}`)
      if (module.requires.some(capability => !capabilities.includes(capability))) throw new Error(`Missing host capability for module: ${module.id}`)
      ids.add(module.id)
      for (const resource of module.resources ?? []) {
        const key = `${resource.name}/${resource.relativePath}`
        if (!identifier(resource.name) || !/^(SKILL\.md|references\/[a-z0-9-]+\.md)$/.test(resource.relativePath) || resources.has(key)) throw new Error(`Invalid or duplicate resource: ${key}`)
        resources.add(key)
      }
    }
    this.#entries = registrations.map(({ module, configuration }) => ({ module: Object.freeze({ ...module, requires: [...module.requires], conflicts: [...module.conflicts ?? []], resources: (module.resources ?? []).map(resource => Object.freeze({ ...resource })) }), configuration: module.configure(configuration) }))
    this.#resources = Object.freeze(this.#entries.flatMap(({ module }) => module.resources ?? []))
  }
  get drained(): boolean { return this.#mounted.length === 0 && !this.#rollbackFailed }
  resources(): readonly ModuleResource[] { return [...this.#resources] }
  ids(): readonly string[] { return this.#entries.map(entry => entry.module.id) }
  /** A requested or persisted feature may never silently fall back to another route. */
  require(binding: ModuleBinding): void {
    const module = this.#entries.find(entry => entry.module.id === binding.moduleId)?.module
    if (!module || module.coreVersion !== binding.version) throw new Error(`Required module unavailable: ${binding.moduleId}`)
    if (this.#state !== 'active') throw new Error('Module ingress is stopped')
  }
  /** Both may be installed; the host must admit only a nonconflicting request selection. */
  admit(bindings: readonly ModuleBinding[]): void {
    const ids = new Set<string>()
    for (const binding of bindings) {
      this.require(binding)
      if (ids.has(binding.moduleId) || !binding.requestId || !binding.sessionId || !binding.workspace) throw new Error('Invalid module request binding')
      const first = bindings[0]!
      if (binding.requestId !== first.requestId || binding.sessionId !== first.sessionId || binding.workspace !== first.workspace) throw new Error('Module request identity mismatch')
      ids.add(binding.moduleId)
    }
    for (const binding of bindings) {
      const module = this.#entries.find(entry => entry.module.id === binding.moduleId)!.module
      if (module.conflicts?.some(id => ids.has(id))) throw new Error(`Conflicting module request: ${module.id}`)
    }
  }
  mount(host: Host): Promise<void> {
    if (this.#state !== 'new' && this.#state !== 'mounting' && this.#state !== 'active') return Promise.reject(new Error('Module registry cannot be restarted'))
    return this.#start ??= this.#mount(host)
  }
  async #mount(host: Host): Promise<void> {
    this.#state = 'mounting'
    try {
      for (const { module, configuration } of this.#entries) {
        if (this.#state !== 'mounting') throw new Error('Module mount was stopped')
        if (!module.mount) continue
        const cleanup: (() => void | Promise<void>)[] = []
        try {
          const handle = await module.mount({ host, defer: operation => cleanup.push(operation) }, configuration)
          this.#mounted.push({ id: module.id, handle, cleanup })
          if (this.#state !== 'mounting') handle.stopIngress()
        } catch (error) {
          const failures = [error]
          await cleanups(cleanup, failures)
          if (failures.length > 1) this.#rollbackFailed = true
          throwFailures(failures, `Partial module mount failed: ${module.id}`)
        }
      }
      if (this.#state !== 'mounting') throw new Error('Module mount was stopped')
      this.#state = 'active'
    } catch (error) {
      this.stopIngress()
      const failures = [error, ...this.#stopFailures]
      await this.#release(failures)
      this.#state = 'failed'
      throwFailures(failures, 'Module composition startup failed')
    }
  }
  stopIngress(): void {
    if (this.#state === 'stopping' || this.#state === 'disposed' || this.#state === 'failed') return
    this.#state = 'stopping'
    for (const entry of [...this.#mounted].reverse()) {
      try { entry.handle.stopIngress() } catch (error) { this.#stopFailures.push(error) }
    }
  }
  async #release(failures: unknown[]): Promise<void> {
    // Never release shared resources while a feature still has unknown/in-flight work.
    let drained = true
    for (const entry of [...this.#mounted].reverse()) {
      try { await entry.handle.drain() } catch (error) { drained = false; failures.push(error) }
    }
    if (!drained) return
    for (const entry of [...this.#mounted].reverse()) {
      try { await entry.handle.dispose() } catch (error) { failures.push(error) }
      await cleanups(entry.cleanup, failures)
    }
    this.#mounted.length = 0
  }
  dispose(): Promise<void> {
    this.stopIngress()
    return this.#shutdown ??= (async () => {
      await this.#start // Startup owns rollback; preserve its failure.
      const failures = [...this.#stopFailures]
      await this.#release(failures)
      this.#state = failures.length ? 'failed' : 'disposed'
      throwFailures(failures, 'Module composition shutdown failed')
    })()
  }
}
