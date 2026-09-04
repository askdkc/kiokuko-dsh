declare module '@deepseek-ai/dsh-session-log-export/client' {
  import type { Context } from '@deepseek-ai/cordis'
  export const inject: readonly ['slots', 'locale']
  export function apply(ctx: Context): void
}
