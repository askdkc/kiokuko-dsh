import { z } from 'zod'

/** Runtime configuration accepted by the dsh bundle entrypoint. */
export const Config = z.object({
  enabled: z.boolean().default(true),
})

export type Config = z.infer<typeof Config>
