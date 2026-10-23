/** Transport-only inherited settings plus a fresh consumer HOME/cache. */
export function consumerInstallEnvironment(inherited: Record<string, string | undefined>, directories: { home: string; cache: string }): Record<string, string | undefined>
