import {roundRatio} from './inventory-cost'
import {TAX_RECOGNITION,type TaxRecognition,type TaxJournalLine} from './deferred-tax-types'
export function deferredTaxAmounts(bookValue:bigint,taxBase:bigint,rateBp:number,recognizedAsset:bigint) {
  if(bookValue<0n||taxBase<0n||!Number.isInteger(rateBp)||rateBp<0||rateBp>10000)throw new Error('Use non-negative book/tax bases and a tax rate from 0% to 100%.')
  const difference=bookValue-taxBase,liability=difference>0n?roundRatio(difference,BigInt(rateBp),10000n):0n,potentialAsset=difference<0n?roundRatio(-difference,BigInt(rateBp),10000n):0n
  if(recognizedAsset<0n||recognizedAsset>potentialAsset)throw new Error('Recognized deferred tax asset cannot exceed the reviewed potential asset.')
  return {difference,liability,potentialAsset,recognizedAsset}
}
export function deferredTaxJournal(liability:bigint,asset:bigint,previousLiability:bigint,previousAsset:bigint,recognition:TaxRecognition):TaxJournalLine[] {
  if([liability,asset,previousLiability,previousAsset].some(n=>n<0n)||!TAX_RECOGNITION[recognition])throw new Error('Invalid deferred tax balances or recognition destination.')
  const lines:TaxJournalLine[]=[],counterpart=TAX_RECOGNITION[recognition]
  const pair=(amount:bigint,debit:string,credit:string)=>{if(amount>0n)lines.push({account:debit,debit:amount.toString(),credit:'0'},{account:credit,debit:'0',credit:amount.toString()})}
  const dl=liability-previousLiability,da=asset-previousAsset
  if(dl>0n)pair(dl,counterpart,'Deferred tax liability');else pair(-dl,'Deferred tax liability',counterpart)
  if(da>0n)pair(da,'Deferred tax asset',counterpart);else pair(-da,counterpart,'Deferred tax asset')
  return lines
}
