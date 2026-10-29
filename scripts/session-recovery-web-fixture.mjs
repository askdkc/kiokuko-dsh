/** Observation only: saved routes are restored by the packaged Models plugin. */
import { appendFileSync, writeFileSync } from 'node:fs'
export const inject = ['llm', 'sessions', 'commands']
export function apply(ctx) {
  const record = value => appendFileSync(process.env.KIOKUKO_RECOVERY_EVENTS, JSON.stringify(value)+'\n')
  ctx.on('session/event', (session, event) => {
    if (['user/message','assistant/message','command/done','tool/call','turn/end'].includes(event.type)) record({sessionId:session.id,event})
  }, {global:true})
  const timer = setInterval(() => {
    const providers = ctx.llm.listProviders().map(value=>value.id)
    if (providers.includes('kiokuko-opencode-go-a5676c4f')) {
      clearInterval(timer)
      writeFileSync(process.env.KIOKUKO_RECOVERY_READY, JSON.stringify({providers}))
    }
  }, 25)
  ctx.effect(()=>()=>clearInterval(timer))
}
