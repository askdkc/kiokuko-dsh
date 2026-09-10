import { AsyncLocalStorage } from 'node:async_hooks'
import type { DeepModel } from './core/contracts.js'
export const deepMemoryRequestScope = new AsyncLocalStorage<{ runId: string; processId: string; model: DeepModel; maxTokens: number; sessionId: string }>()
