/** Money is cents; time is hundredths of an hour. ROE hours are never a costing basis. */
export function labourShare(total:bigint,hours:bigint,normalHours:bigint) {
 if(total<0n||hours<0n||normalHours<=0n||hours>normalHours)throw new Error('Invalid normal-capacity labour basis')
 return (total*hours+normalHours/2n)/normalHours
}
export type Fraction={n:bigint;d:bigint}
const gcd=(a:bigint,b:bigint):bigint=>b===0n?(a<0n?-a:a):gcd(b,a%b)
export const fraction=(n:bigint,d=1n):Fraction=>{if(d<=0n)throw new Error('Invalid fraction');const g=gcd(n,d);return {n:n/g,d:d/g}}
export const add=(a:Fraction,b:Fraction)=>fraction(a.n*b.d+b.n*a.d,a.d*b.d)
export const scale=(a:Fraction,n:bigint,d:bigint)=>fraction(a.n*n,a.d*d)
export const negative=(a:Fraction)=>fraction(-a.n,a.d)
export const ZERO=fraction(0n)
export const rounded=(a:Fraction)=>a.n<0n?-((-a.n+a.d/2n)/a.d):(a.n+a.d/2n)/a.d
/** Cumulative rounding preserves the exact total, including signed correction components. */
export function roundedShares<T>(rows:{target:T;value:Fraction}[],multiplier=1n) {
 let sum=ZERO,previous=0n
 return rows.map(r=>{sum=add(sum,scale(r.value,multiplier,1n));const next=rounded(sum),amount=next-previous;previous=next;return {target:r.target,amount}})
}
