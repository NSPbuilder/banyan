export type DepreciationMethod='none'|'straight_line'|'declining_balance'|'manual'
export const DEPRECIATION_METHODS:Record<DepreciationMethod,string>={none:'No depreciation',straight_line:'Straight line',declining_balance:'Declining balance',manual:'Manual'}
export type DepreciationPolicy={id:string;asset_id:string;method:DepreciationMethod;start_date:string;residual_value:string;life_months:number;annual_rate_bp:number;version:number;opening_accumulated?:string}
export type DepreciationEntry={id:string;asset_id:string;entry_date:string;period_start:string|null;period_end:string|null;kind:'automatic'|'manual';amount:string;note:string;created_by:string}
export type DepreciationAsset={id:string;code:string;name:string;acquisition_cost:string;acquired_on:string;disposed_on:string|null;status:string;accumulated:string;net_book_value:string;policy:DepreciationPolicy|null;entries:DepreciationEntry[]}
export const CCA_CLASSES=[
  {code:'1',label:'Buildings',rate:400,standard:true},{code:'3',label:'Older buildings',rate:500,standard:true},
  {code:'6',label:'Certain buildings',rate:1000,standard:true},{code:'8',label:'Equipment and furniture',rate:2000,standard:true},
  {code:'10',label:'Vehicles and equipment',rate:3000,standard:true},{code:'10.1',label:'Passenger vehicles (separate pool)',rate:3000,standard:false},
  {code:'12',label:'Tools and certain software',rate:10000,standard:false},{code:'14.1',label:'Intangibles / goodwill',rate:500,standard:false},
  {code:'43',label:'Manufacturing machinery',rate:3000,standard:false},{code:'43.1',label:'Clean energy',rate:3000,standard:false},
  {code:'43.2',label:'Clean energy',rate:5000,standard:false},{code:'44',label:'Patents',rate:2500,standard:false},
  {code:'46',label:'Data network equipment',rate:3000,standard:false},{code:'50',label:'Computer equipment',rate:5500,standard:true},
  {code:'53',label:'Manufacturing machinery (before 2026)',rate:5000,standard:false},{code:'54',label:'Zero-emission vehicles',rate:3000,standard:false},
  {code:'55',label:'Zero-emission taxis / rental vehicles',rate:4000,standard:false},{code:'56',label:'Zero-emission equipment',rate:3000,standard:false}
]
export type CcaRule='half_year'|'no_half_year'|'aiip'|'riip'|'manual'
export const CCA_RULES:Record<CcaRule,string>={half_year:'Standard half-year',no_half_year:'No half-year (eligible exception)',aiip:'Eligible AII property',riip:'Eligible RII property',manual:'Manual / special rule'}
export type CcaPool={id:string;name:string;class_code:string;rate_bp:number;calculation:'standard'|'manual';opening_ucc:string;start_date:string;version:number;latest_closing:string|null;latest_end:string|null}
export type CcaAssignment={id:string;asset_id:string;asset_code:string;asset_name:string;acquired_on:string;pool_id:string;tax_cost:string;available_on:string;first_year_rule:CcaRule;eligibility_note:string;disposed_on:string|null;proceeds:string;version:number}
export type CcaYear={id:string;pool_id:string;start_date:string;end_date:string;opening_ucc:string;additions:string;disposals:string;basis_adjustment:string;maximum_cca:string;claimed_cca:string;recapture:string;terminal_loss:string;closing_ucc:string;note:string;created_by:string;policy_version?:string|null}
