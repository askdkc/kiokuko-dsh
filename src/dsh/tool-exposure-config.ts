import { z } from 'zod'

/** Core-safe configuration schema for the optional tool projection. */
export const ToolExposureConfig = z.object({ mode: z.enum(['auto', 'full', 'phase', 'lean']).default('auto') }).strict()
export type ToolExposureConfig = z.infer<typeof ToolExposureConfig>
