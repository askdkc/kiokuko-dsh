export interface DshUpstreamIdentity {
  schema: 'kiokuko-dsh-upstream-v1'
  repository: string
  sha: string
  sourceRoot: string
  version: string
  developmentPackageRoot?: string
}

export interface DshRuntimeSelection {
  mode: 'current' | 'historical'
  packageRoot: string
  manifest: { name: string; version: string; [key: string]: unknown }
  upstream?: DshUpstreamIdentity
  environment: NodeJS.ProcessEnv
}

export function assertDshFixtureIdentity(
  fixtureRoot: string,
  installed?: { name?: string; version?: string },
): DshUpstreamIdentity | undefined

export function dshRuntimeMode(environment?: NodeJS.ProcessEnv): 'current' | 'historical'

export function selectedDshRuntime(root: string, environment?: NodeJS.ProcessEnv): DshRuntimeSelection
