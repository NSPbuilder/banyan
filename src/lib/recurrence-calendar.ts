import { AutomationError } from './automation-errors'

export function validBusinessDate(date:string) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.slice(0,4)==='0000'||!Number.isFinite(new Date(date+'T12:00:00Z').getTime())
    ||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw new AutomationError('DATE','Enter a real business date.')
  return date
}
export function addDays(date:string,days:number) {
  validBusinessDate(date);if(!Number.isInteger(days))throw new AutomationError('DATE','Enter a whole number of days.')
  const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return validBusinessDate(d.toISOString().slice(0,10))
}
export type RecurrenceRule={frequency:'weekly'|'monthly'|'quarterly'|'yearly';dayMode:'fixed'|'month_end'|'last_weekday';anchorDate:string;dayOfMonth:number}
function inMonth(year:number,month:number,rule:RecurrenceRule) {
  if(year<1||year>9999)throw new AutomationError('DATE','The schedule exceeds supported business dates.')
  const inDay=(day:number)=>{const d=new Date('2000-01-01T12:00:00Z');d.setUTCFullYear(year,month,day);return d}
  const end=inDay(1);end.setUTCMonth(month+1,0);const last=end.getUTCDate()
  let day=rule.dayMode==='fixed'?Math.min(rule.dayOfMonth,last):last
  if(rule.dayMode==='last_weekday')while([0,6].includes(inDay(day).getUTCDay()))day--
  return validBusinessDate(inDay(day).toISOString().slice(0,10))
}
export function validateRule(rule:RecurrenceRule) {
  validBusinessDate(rule.anchorDate)
  if(!['weekly','monthly','quarterly','yearly'].includes(rule.frequency)||!['fixed','month_end','last_weekday'].includes(rule.dayMode)
    ||!Number.isInteger(rule.dayOfMonth)||rule.dayOfMonth<1||rule.dayOfMonth>31||(rule.frequency==='weekly'&&rule.dayMode!=='fixed'))
    throw new AutomationError('SCHEDULE','Choose a supported weekly/monthly/quarterly/yearly calendar rule.')
}
export function nextOccurrence(rule:RecurrenceRule,after?:string):string {
  validateRule(rule)
  if(rule.frequency==='weekly')return after?addDays(validBusinessDate(after),7):rule.anchorDate
  const step=rule.frequency==='monthly'?1:rule.frequency==='quarterly'?3:12
  const anchor=new Date(rule.anchorDate+'T12:00:00Z'),start=after?new Date(validBusinessDate(after)+'T12:00:00Z'):anchor
  let month=start.getUTCFullYear()*12+start.getUTCMonth()
  const origin=anchor.getUTCFullYear()*12+anchor.getUTCMonth()
  if(after)month+=step
  else while((month-origin)%step!==0)month++
  let date=inMonth(Math.floor(month/12),month%12,rule)
  if(!after&&date<rule.anchorDate){month+=step;date=inMonth(Math.floor(month/12),month%12,rule)}
  return date
}
export function futureOccurrences(rule:RecurrenceRule,first:string,limit=12) {
  const dates:string[]=[];let date=first
  const count=Math.min(12,Math.max(1,limit));validBusinessDate(first)
  for(let i=0;i<count;i++){dates.push(date);if(i+1<count)date=nextOccurrence(rule,date)}return dates
}
