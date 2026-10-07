import { z } from 'zod'

/** One default for schemas, saved configurations with no field, and direct native adapters. */
export const IntakeModeConfig = z.enum(['eager', 'on-demand']).default('on-demand')
export type IntakeMode = z.output<typeof IntakeModeConfig>
