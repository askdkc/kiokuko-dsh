import { Context } from '@deepseek-ai/cordis'

/** Resolve the host root across Cordis's symbol and legacy property APIs.
 * Prefer the symbol: a current context may have an unrelated `root` service. */
export function contextRoot(ctx: Context): Context {
  const key: unknown = Reflect.get(Context, 'root')
  if (typeof key === 'symbol') return (Reflect.get(ctx, key) as Context | undefined) ?? ctx
  return (Reflect.get(ctx, 'root') as Context | undefined) ?? ctx
}
