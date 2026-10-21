import type {CorrectionBackend} from '../../memory/correction-classification.js'
import type {CorrectionMode} from '../../memory/correction-contract.js'
import type {DecisionService} from './service.js'

/** The configured Typed Decisions provider owns inference; no Jev-specific path. */
export async function correctionClassifier(service?:DecisionService):Promise<{mode:CorrectionMode;backend?:CorrectionBackend}>{
  if(!service)return {mode:'shadow'}
  await service.initialize()
  const mode=service.correctionClassificationMode()
  if(mode==='off')return {mode}
  return {mode,backend:{configurationDigest:service.configurationDigest(),evaluate:async(id,batch,signal)=>{
    const config=await service.bind(id,signal)
    const outcome=await service.evaluate(id,batch,signal)
    return outcome.status==='completed'?{...outcome,attested:config.provider!=='laya-coreml'||config['laya-coreml']?.protocol!=='v1'}:outcome
  }}}
}
