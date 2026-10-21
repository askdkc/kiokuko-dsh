const ratio=(n,d)=>d===0?null:n/d
export function correctionMetrics(rows){
  const special=rows.filter(x=>x.gold==='capability_compatibility'),other=rows.filter(x=>x.gold!=='capability_compatibility')
  const successful=rows.filter(x=>['classified','abstained'].includes(x.state)),selected=rows.filter(x=>x.state==='classified'),tp=special.filter(x=>x.actual==='capability_compatibility').length,
    fp=other.filter(x=>x.actual==='capability_compatibility').length,failures=rows.filter(x=>['unavailable','stale','unclassified'].includes(x.state)).length
  const times=rows.map(x=>x.elapsedMs).filter(x=>typeof x==='number'&&Number.isFinite(x)).sort((a,b)=>a-b),tokens=rows.filter(x=>x.inputTokens!==null&&x.inputTokens!==undefined)
  const percentile=p=>times.length?times[Math.max(0,Math.ceil(times.length*p)-1)]:null
  const labels=['capability_compatibility','reference','uncertain','provider_failure']
  const confusion=Object.fromEntries(labels.slice(0,3).map(gold=>[gold,Object.fromEntries(labels.map(actual=>[actual,rows.filter(x=>x.gold===gold&&(['classified','abstained'].includes(x.state)?x.actual:'provider_failure')===actual).length]))]))
  return {attempted:rows.length,correct:successful.filter(x=>x.actual===x.gold).length,confusion,
    accuracy:ratio(successful.filter(x=>x.actual===x.gold).length,rows.length),
    semanticOnlyAccuracy:ratio(selected.filter(x=>x.actual===x.gold).length,selected.length),coverage:ratio(selected.length,rows.length),
    trueSpecial:tp,falseSpecial:fp,falseNonSpecial:special.length-tp,trueNonSpecial:other.length-fp,goldSpecial:special.length,goldNonSpecial:other.length,
    specialPrecision:ratio(tp,tp+fp),specialRecall:ratio(tp,special.length),falseSpecialRate:ratio(fp,other.length),falseSpecialDenominator:'all gold non-special cases, including gold uncertain',
    abstentionRate:ratio(rows.filter(x=>x.state==='abstained').length,rows.length),providerFailureRate:ratio(failures,rows.length),providerFailures:failures,
    latencyMs:{mean:ratio(times.reduce((a,b)=>a+b,0),times.length),p50:percentile(.5),p95:percentile(.95)},
    inputTokens:{reportedCases:tokens.length,total:tokens.length?tokens.reduce((n,x)=>n+x.inputTokens,0):null,mean:tokens.length?tokens.reduce((n,x)=>n+x.inputTokens,0)/tokens.length:null},
    denominatorZero:'null, never zero or success'}
}
/** Frozen historical baseline, permitted only in evaluation. */
export function originalCorrectionRegex(entry){
  const text=[entry.title,entry.summary??entry.body].join('\n')
  return /version|compiler|版数|バージョン|版番号/iu.test(text)&&/capabilit|only because|solely|不要.*固定|決め打ち|能力|互換性.*確認|版.*だけ/iu.test(text)?'capability_compatibility':'reference'
}
export function correctionEvaluation(rows){
  const overall=correctionMetrics(rows),languages=Object.fromEntries([...new Set(rows.map(x=>x.language))].map(language=>[language,correctionMetrics(rows.filter(x=>x.language===language))]))
  const qualified=overall.specialPrecision!==null&&overall.specialPrecision>=.95&&overall.specialRecall!==null&&overall.specialRecall>=.90&&overall.falseSpecialRate!==null&&overall.falseSpecialRate<=.02
    &&Object.values(languages).every(x=>x.specialPrecision!==null&&x.specialPrecision>=.95&&x.specialRecall!==null&&x.specialRecall>=.90)
  return {overall,languages,gates:{specialPrecision:.95,specialRecall:.90,falseSpecialRate:.02,noSharplyFailingLanguage:'each tested language meets the precision and recall gates',qualified},
    baseline:correctionMetrics(rows.map(x=>({...x,actual:x.baseline,state:'classified',elapsedMs:null,inputTokens:0}))),
    baselineLanguages:Object.fromEntries(Object.keys(languages).map(language=>[language,correctionMetrics(rows.filter(x=>x.language===language).map(x=>({...x,actual:x.baseline,state:'classified',elapsedMs:null,inputTokens:0})))]))}
}
