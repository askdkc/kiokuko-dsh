import type {SqliteDatabase} from '../db/adapter.js'
import type {TapSummary} from './node-tap-summary.js'
import type { CodingDefinition } from './coding-workflow/contracts.js'

interface Identity {runId:string;workspace:string;orchestrationId:string}
interface CompletionVerifiers {
  criteria(db:SqliteDatabase,identity:Identity):{revision:number;criteria:readonly {id:string;description:string}[]}
  results(db:SqliteDatabase,identity:Identity,root:string,workUnitId?:string):readonly {verifierId:string;status:string;tapSummary?:TapSummary;explicitCases?:boolean;receiptId?:string}[]|null|undefined
  codingProjection?(db:SqliteDatabase,identity:Identity): { definition:CodingDefinition; approved:boolean; completed:boolean;
    bindings:readonly { criterionId:string; verifierId:string; workUnitId?:string }[] } | undefined
}
let readers:CompletionVerifiers|undefined
/** The optional Enno module supplies its own readers; core never imports that module. */
export function registerCompletionVerifiers(value:CompletionVerifiers):void { readers=value }
export function completionVerifiers():CompletionVerifiers {
  if(!readers)throw new Error('Enno completion requires the loaded Enno module')
  return readers
}
