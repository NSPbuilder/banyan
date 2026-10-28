import type { TaxCode } from './tax-rates'

export type ProjectTaxRole='gst_hst_payable'|'gst_hst_recoverable'|'qst_pst_payable'|'qst_pst_recoverable'
export type ProjectTaxBindings={
  accounts:Partial<Record<ProjectTaxRole,{id:string;label:string}>>
  errors:Partial<Record<ProjectTaxRole,string>>
}
type TaxLine={taxCode?:TaxCode|null;gst?:bigint|string;pst?:bigint|string;pstRecoverable?:bigint|string|null}
/** A selected tax code requires setup even when its amount is overridden to 0. */
export function projectTaxRequirements(kind:'revenue'|'cost',lines:TaxLine[]) {
  const needsGST=lines.some(l=>l.taxCode==='GST'||l.taxCode==='GST_PST'||BigInt(l.gst||0)!==0n)
  const needsPST=lines.some(l=>l.taxCode==='PST'||l.taxCode==='GST_PST'||BigInt(l.pst||0)!==0n)
  const recoverPST=kind==='cost'&&lines.some(l=>BigInt(l.pstRecoverable||0)>0n)
  const requirements:Array<{roles:ProjectTaxRole[];label:string}>=[]
  if(needsGST)requirements.push({roles:[kind==='revenue'?'gst_hst_payable':'gst_hst_recoverable'],label:kind==='revenue'?'GST/HST payable':'GST/HST recoverable'})
  if(needsPST)requirements.push({roles:kind==='revenue'?['qst_pst_payable']:recoverPST?['qst_pst_recoverable']:['qst_pst_payable','qst_pst_recoverable'],
    label:kind==='revenue'?'PST/QST payable':recoverPST?'PST/QST recoverable':'PST/QST'})
  return requirements
}
export function projectTaxErrors(bindings:ProjectTaxBindings,kind:'revenue'|'cost',lines:TaxLine[]) {
  return projectTaxRequirements(kind,lines).filter(r=>!r.roles.some(role=>bindings.accounts[role]))
    .map(r=>r.roles.map(role=>bindings.errors[role]).find(Boolean)
      ||`This company has no active ${r.label} account. Add or reactivate one in Accounts before using this tax code.`)
}
