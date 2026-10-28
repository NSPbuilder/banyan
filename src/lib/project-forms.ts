import { parseMoney } from './money'
import { ProjectError, type ProjectLine } from './project'
import { lineGst, linePst, lineTaxCode } from './forms'
import { TAX_CODES, computeEnteredTax, parseTaxOverride, type TaxCode } from './tax-rates'

export const projectField=(f:FormData,k:string)=>String(f.get(k)??'').trim()
export const projectOptional=(f:FormData,k:string)=>projectField(f,k)||undefined
export function projectMoney(value:string,label='Amount') {
  try { return parseMoney(value) }
  catch { throw new ProjectError('AMOUNT',`${label}: enter an amount with at most two decimal places.`) }
}
export function projectVersion(f:FormData) {
  const value=projectField(f,'version')
  if(!/^[1-9]\d*$/.test(value)) throw new ProjectError('VERSION','Refresh to load the current record version.')
  return Number(value)
}
export function projectLineRows(f:FormData,kind:'revenue'|'cost'):Array<{line:ProjectLine;index:number}> {
  const kinds=f.getAll('lineKind').map(String),bases=f.getAll('base').map(String)
  if(f.has(lineTaxCode(0))) {
    const descriptions=kind==='revenue'?f.getAll('lineDescription').map(String):[]
    if(!kinds.length||kinds.length>200||bases.length!==kinds.length||(descriptions.length>0&&descriptions.length!==kinds.length))throw new ProjectError('LINES','The line fields are incomplete. Refresh and try again.')
    return kinds.map((category,i)=>{
      const code=projectField(f,lineTaxCode(i)) as TaxCode
      if(!TAX_CODES.some(t=>t.code===code))throw new ProjectError('TAX',`Choose a tax code on line ${i+1}.`)
      let tax:ReturnType<typeof computeEnteredTax>
      try {tax=computeEnteredTax(projectMoney(bases[i]),code,false,projectField(f,'date'),{
        gst:parseTaxOverride(projectField(f,lineGst(i))),pst:parseTaxOverride(projectField(f,linePst(i)))})}
      catch(e) {throw new ProjectError('TAX',`Line ${i+1}: ${e instanceof Error?e.message:'Check the tax amounts.'}`)}
      const line:ProjectLine={kind:(kind==='revenue'?'revenue':category) as ProjectLine['kind'],description:descriptions[i]?.trim()||'',base:tax.base,gst:tax.gst,pst:tax.pst,
        gstRecoverable:kind==='cost'?tax.gst:null,pstRecoverable:kind==='cost'?0n:null,taxCode:code}
      return {line,index:i}
    }).filter(({line:l})=>l.base!==0n||l.gst!==0n||l.pst!==0n)
  }
  // Older open forms and import callers keep their explicit tax figures.
  const keys=['lineKind','lineDescription','base','gst','pst','gstRecoverable','pstRecoverable']
  const values=Object.fromEntries(keys.map(k=>[k,f.getAll(k).map(String)]))
  const count=values.lineKind.length
  if(!count||count>200||keys.some(k=>values[k].length!==count)) throw new ProjectError('LINES','The line fields are incomplete. Refresh and try again.')
  return Array.from({length:count},(_,i)=>{
    const amount=(key:string,label:string)=>projectMoney(values[key][i],`Line ${i+1} ${label}`)
    const base=amount('base','tax exclusive amount'),gst=amount('gst','GST'),pst=amount('pst','PST')
    const line:ProjectLine={kind:(kind==='revenue'?'revenue':values.lineKind[i]) as ProjectLine['kind'],description:values.lineDescription[i],base,gst,pst,
      gstRecoverable:kind==='revenue'||values.gstRecoverable[i].trim()===''?null:amount('gstRecoverable','recoverable GST'),
      pstRecoverable:kind==='revenue'||values.pstRecoverable[i].trim()===''?null:amount('pstRecoverable','recoverable PST')}
    return {line,index:i}
  }).filter(({line:l})=>l.base!==0n||l.gst!==0n||l.pst!==0n)
}
export const projectLines=(f:FormData,kind:'revenue'|'cost')=>projectLineRows(f,kind).map(r=>r.line)
