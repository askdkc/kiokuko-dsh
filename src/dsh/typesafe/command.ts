import type { DshNativeCommandDefinition } from '../commands.js'
import { TypeSafeCredentials, type CredentialInfo, type TypeSafeCredentialProvider } from './credentials.js'
import { TypeSafeError } from './contracts.js'

export function typeSafeCredentials(ctx: { get(name: string, strict?: boolean): unknown }): TypeSafeCredentials {
  return new TypeSafeCredentials(() => ctx.get('credentials', false) as TypeSafeCredentialProvider | undefined)
}
function statusText(info: CredentialInfo): string {
  return `TypeSafe: ${info.configured ? 'configured' : 'not configured'}; source: ${info.source ?? 'none'}; ${info.writable ? 'writable' : 'read-only'}.`
}
export function mountTypeSafeCommand(commands: { register(definition: DshNativeCommandDefinition): () => void }, credentials: TypeSafeCredentials, onChanged?: () => void): () => void {
  return commands.register({ name: 'kioku-typesafe-key', description: 'Save the TypeSafe key, inspect status, or clear the stored key. Input is visible while typing.',
    input: { hint: '<key> | status | clear' }, recordInput: false,
    handler: async invocation => {
      try {
        if (invocation.signal.aborted) throw new TypeSafeError('CANCELLED')
        const input = invocation.rawInput.trim()
        if (!input || input === 'status') return { kind: 'success', text: statusText(await credentials.status()) }
        await credentials.change(input === 'clear' ? undefined : input, invocation.signal)
        onChanged?.()
        if (input !== 'clear') return { kind: 'success', text: 'TypeSafe key saved. No API request was made; the key has not been verified.' }
        try { return { kind: 'success', text: `Stored TypeSafe key cleared. ${statusText(await credentials.status())}` } }
        catch { return { kind: 'success', text: 'Stored TypeSafe key cleared. Remaining credential source could not be checked; run /kioku-typesafe-key status.' } }
      } catch (error) {
        const problem = error instanceof TypeSafeError ? error : new TypeSafeError('STORAGE_FAILED')
        return { kind: 'error', text: `${problem.code}: ${problem.message}` }
      }
    } })
}
