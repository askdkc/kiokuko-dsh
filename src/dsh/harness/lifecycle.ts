import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export interface HarnessStep {
  agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal
  /** A Kiokuko subsystem has durably accepted this exact input, even if it
   * deliberately suppresses the ordinary model step. Not an execution grant. */
  inputHandled?:()=>void
}
/** Direct Kiokuko lifecycle calls. Public DSH events remain observer/extension seams. */
export class KiokukoHarnessLifecycle {
  private readonly steps: Array<(event: HarnessStep, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>> = []
  private readonly stopping: Array<(event: Omit<HarnessStep, 'messages' | 'step'>) => Promise<void> | void> = []
  private readonly idle: Array<(agent: Agent) => void> = []
  private add<T>(list: T[], fn: T): () => void { list.push(fn); return () => { const i=list.indexOf(fn); if(i>=0)list.splice(i,1) } }
  onStep(fn: (event: HarnessStep, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) { return this.add(this.steps,fn) }
  onStopping(fn: (event: Omit<HarnessStep,'messages'|'step'>) => Promise<void> | void) { return this.add(this.stopping,fn) }
  onIdle(fn: (agent: Agent) => void) { return this.add(this.idle,fn) }
  preStep(event: HarnessStep, admit: () => Promise<PreStepDecision> = () => Promise.resolve({kind:'enter',messages:event.messages})): Promise<PreStepDecision> {
    let i=0
    const next = (): Promise<PreStepDecision> => this.steps[i++]?.(event,next) ?? admit()
    return next()
  }
  async turnStopping(event: Omit<HarnessStep,'messages'|'step'>) { for(const fn of [...this.stopping])await fn(event) }
  becameIdle(agent: Agent) { for(const fn of [...this.idle])fn(agent) }
}
