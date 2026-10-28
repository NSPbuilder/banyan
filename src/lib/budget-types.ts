import { allocate } from './money'
export type BudgetCell={accountId:string;periodId:string;amount:string}
export type BudgetOperation={kind:'manual';cells:BudgetCell[]}|{kind:'spread';accountId:string;annualAmount:string}|{kind:'percent';accountIds:string[];periodIds:string[];basisPoints:number}|{kind:'prefill'}|{kind:'copy';sourceBudgetId:string}
export function spreadCents(total:bigint,count:number) {
 if(!Number.isSafeInteger(count)||count<1||count>24)throw Error('Use the actual fiscal period count (1–24).')
 return allocate(total,Array(count).fill(1))
}
export function budgetVariance(type:'revenue'|'expense'|'profit',actual:bigint,budget:bigint) {
 const favorable=type==='expense'?budget-actual:actual-budget,denominator=budget<0n?-budget:budget
 return {favorable,percentageBasisPoints:denominator===0n?null:favorable*10000n/denominator}
}
