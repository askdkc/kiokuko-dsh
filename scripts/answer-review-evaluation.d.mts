export const labels: string[]
export function summarize(cases: any[]): any
export function schedule<T>(examples: T[], repetitions: number, seed: number): { language: string; example: T; attempt: number }[]
