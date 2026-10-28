import {daysInMonth} from './dates'

/** Client-safe setup vocabulary. These choices personalize the guide, not access grants. */
export const COMPANY_SETUP_STEPS=['Company','Books','Your work','Starting point','Review'] as const
export const SETUP_WORKFLOWS=[
 {id:'invoices',title:'Invoice customers',description:'Customers, invoice style and your first invoice.',icon:'Invoices',seat:'/invoices'},
 {id:'payroll',title:'Pay employees',description:'Employee records, payroll and employer contributions.',icon:'Payroll',seat:'/payroll'},
 {id:'inventory',title:'Manage stock and production',description:'Raw materials, WIP, finished goods and costing.',icon:'Inventory',seat:'/inventory'},
 {id:'assets',title:'Track fixed assets',description:'Asset purchases, book depreciation and CCA.',icon:'Fixed assets',seat:'/assets'},
 {id:'projects',title:'Track project costs',description:'Project budgets, time, costs and billing.',icon:'Project',seat:'/projects'},
] as const
export const SETUP_STARTS=[
 {id:'fresh',title:'Start fresh',description:'Begin with your new company’s accounts and record transactions as they happen.'},
 {id:'existing',title:'Bring opening balances',description:'Review a trial balance and carry over what customers and suppliers owe.'},
 {id:'csv',title:'Import existing books from CSV',description:'Use the migration workspace to upload, validate and review your opening data.'},
] as const
export type SetupFocus=typeof SETUP_WORKFLOWS[number]['id']
export type SetupStart=typeof SETUP_STARTS[number]['id']
export type SetupChart='core'|'standard'
export type CompanySetupPlan={start:SetupStart;focus:SetupFocus[];chart?:SetupChart}
export class CompanySetupError extends Error {constructor(message:string){super(message);this.name='CompanySetupError'}}
export function companySetupPlan(input:{start?:string;focus?:string[];chart?:string}):CompanySetupPlan {
 const start=input.start??'fresh',focus=[...new Set(input.focus??['invoices'])]
 if(!SETUP_STARTS.some(s=>s.id===start)||focus.some(id=>!SETUP_WORKFLOWS.some(w=>w.id===id)))throw new CompanySetupError('Choose the starting point and workflows from the setup guide.')
 if(input.chart!==undefined&&!['core','standard'].includes(input.chart))throw new CompanySetupError('Choose a standard GIFI chart or foundational accounts.')
 return {start:start as SetupStart,focus:focus as SetupFocus[],...(input.chart?{chart:input.chart as SetupChart}:{})}
}
export function savedCompanySetupPlan(value:unknown):CompanySetupPlan {
 if(value&&typeof value==='object'&&'start' in value&&'focus' in value&&typeof value.start==='string'&&Array.isArray(value.focus)&&value.focus.every(v=>typeof v==='string')){
  try{return companySetupPlan({start:value.start,focus:value.focus,...('chart' in value&&typeof value.chart==='string'?{chart:value.chart}:{})})}catch{}
 }
 return companySetupPlan({})
}
export const SETUP_MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'] as const
export function fiscalEndOn(month:number,day:number,today:string) {
 const year=Number(today.slice(0,4)),candidate=(y:number)=>`${y}-${String(month).padStart(2,'0')}-${String(Math.min(day,daysInMonth(y,month))).padStart(2,'0')}`
 return candidate(year)>=today?candidate(year):candidate(year+1)
}
export function fiscalEndLabel(value:string) {const [y,m,d]=value.split('-').map(Number);return `${SETUP_MONTHS[m-1]} ${d}, ${y}`}
export function suggestedCompanyCode(name:string) {return name.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12)}
