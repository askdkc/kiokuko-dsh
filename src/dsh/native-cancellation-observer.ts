/** Observe the exact native user's brake without changing its authority or outcome.
 * Optional listener errors cannot change the native result. Required listener failures
 * are reported only after the native brake, without claiming durable success.
 * One shared wrapper permits multiple independent per-agent consumers and safe disposal.
 */
type CancelAgent = { cancel?: (...args: any[]) => unknown }
type Observer = { listeners: Map<() => void,boolean>; original: (...args:any[])=>unknown; wrapper: (...args:any[])=>unknown; descriptor: PropertyDescriptor | undefined }
const observers = new WeakMap<object, Observer>()
export function observeNativeUserCancellation(agent: CancelAgent, listener: () => void, options: { required?: boolean } = {}): () => void {
  if (typeof agent.cancel !== 'function') return () => {}
  let observer = observers.get(agent)
  if (!observer) {
    const original=agent.cancel, descriptor=Object.getOwnPropertyDescriptor(agent,'cancel'), listeners=new Map<()=>void,boolean>()
    const wrapper=function(this:unknown,...args:any[]):unknown {
      let result:unknown, nativeFailed=false, nativeError:unknown
      try { result=original.apply(this,args) } catch(error) { nativeFailed=true;nativeError=error }
      const requiredErrors:unknown[]=[]
      if(args[0]?.kind==='user') for(const [notify,required] of [...listeners]) {
        try { notify() } catch(error) { if(required)requiredErrors.push(error) }
      }
      if(nativeFailed&&requiredErrors.length)throw new AggregateError([nativeError,...requiredErrors],'Native cancellation and required follow-up failed')
      if(nativeFailed)throw nativeError
      if(requiredErrors.length)throw new AggregateError(requiredErrors,'Native brake applied; required follow-up failed')
      return result
    }
    observer={listeners,original,wrapper,descriptor}
    Object.defineProperty(agent,'cancel',{configurable:true,writable:true,value:wrapper})
    observers.set(agent,observer)
  }
  observer.listeners.set(listener,options.required===true)
  return () => {
    observer!.listeners.delete(listener)
    if(observer!.listeners.size) return
    if(agent.cancel===observer!.wrapper) {
      if(observer!.descriptor)Object.defineProperty(agent,'cancel',observer!.descriptor)
      else delete agent.cancel
      observers.delete(agent)
    }
  }
}
