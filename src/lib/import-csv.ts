import { parseCsv } from './bank-csv'
import { IMPORT_FILE_KINDS,IMPORT_FIELDS as FIELDS,type ImportFileKind,type ImportFormat,type ImportStage,type ImportGl } from './import-types'

export class ImportError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='ImportError'}
}
export function fail(code:string,message:string):never {throw new ImportError(code,message)}
/** Validate quoting before reusing the bank CSV parser; retain physical line starts. */
function recordLines(text:string,delimiter:string) {
  const starts=[1];let line=1,state:'start'|'plain'|'quoted'|'closed'='start'
  for(let i=0;i<text.length;i++) {
    const c=text[i]
    if(state==='quoted') {
      if(c==='"'){if(text[i+1]==='"')i++;else state='closed'}
      else if(c==='\n'||c==='\r'){line++;if(c==='\r'&&text[i+1]==='\n')i++}
      continue
    }
    if(c==='"'){if(state!=='start')fail('CSV_QUOTES',`Unexpected quote on source line ${line}.`);state='quoted';continue}
    if(c===delimiter){state='start';continue}
    if(c==='\n'||c==='\r'){line++;if(c==='\r'&&text[i+1]==='\n')i++;starts.push(line);state='start';continue}
    if(state==='closed')fail('CSV_QUOTES',`Unexpected text after closing quote on source line ${line}.`)
    state='plain'
  }
  if(state==='quoted')fail('CSV_QUOTES',`Unterminated quoted field on source line ${line}.`)
  return starts
}
const TYPES=['asset','liability','equity','revenue','expense'] as const

export function canonicalImportFormat(kind:ImportFileKind,headers:string[]):ImportFormat {
  return {delimiter:',',dateFormat:'ISO',amountFormat:'decimal_dot',amountConvention:'signed',columns:Object.fromEntries(FIELDS[kind].filter(h=>headers.includes(h)).map(h=>[h,h])),ignoredColumns:[]}
}
export function importDate(value:string,format:ImportFormat['dateFormat']) {
  let y:number,m:number,d:number
  const matched=format==='ISO'?/^(\d{4})-(\d{2})-(\d{2})$/.exec(value):/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  if(!matched)fail('DATE_FORMAT',`Date ${value} does not match the selected ${format} format.`)
  if(format==='ISO'){y=Number(matched[1]);m=Number(matched[2]);d=Number(matched[3])}
  else{y=Number(matched[3]);m=Number(matched[format==='MDY'?1:2]);d=Number(matched[format==='MDY'?2:1])}
  const actual=new Date(0);actual.setUTCFullYear(y,m-1,d);actual.setUTCHours(0,0,0,0)
  if(y<1||y>9999||actual.getUTCFullYear()!==y||actual.getUTCMonth()!==m-1||actual.getUTCDate()!==d)fail('DATE_INVALID',`Date ${value} is not a supported calendar date.`)
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}
export function importAmount(value:string,format:ImportFormat['amountFormat']) {
  const comma=format.endsWith('comma'),grouped=format.startsWith('grouped')
  const decimal=comma?',':'.',separator=comma?'.':','
  const escaped=(s:string)=>s==='.'?'\\.':s
  const integer=grouped?`(?:\\d{1,3}(?:${escaped(separator)}\\d{3})+|\\d+)`:'\\d+'
  const rule=new RegExp(`^-?${integer}(?:${escaped(decimal)}\\d{1,2})?$`)
  if(!rule.test(value))fail('AMOUNT_FORMAT',`Amount ${value} does not match the selected ${format} format; maximum two decimal places.`)
  const normalized=(grouped?value.split(separator).join(''):value).replace(decimal,'.'),negative=normalized.startsWith('-')
  const [whole,fraction='']=normalized.replace(/^-/,'').split('.')
  const cents=(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')))*(negative?-1n:1n)
  if(cents < -9223372036854775808n || cents > 9223372036854775807n)fail('AMOUNT_RANGE','The amount exceeds the supported integer range.')
  return cents
}
export function parseImportCsv(text:string,kind:ImportFileKind,format:ImportFormat):{headers:string[];stages:ImportStage[];excluded:Array<{sourceLine:number;reason:string}>} {
  if(!IMPORT_FILE_KINDS.includes(kind)||!FIELDS[kind])fail('FILE_KIND','Unsupported import file kind.')
  if(![',',';','\t','|'].includes(format.delimiter)||!['ISO','DMY','MDY'].includes(format.dateFormat)||!['decimal_dot','decimal_comma','grouped_dot','grouped_comma'].includes(format.amountFormat)||!['signed','debit_credit'].includes(format.amountConvention))fail('FORMAT','Choose explicit supported formats.')
  if(Buffer.byteLength(text,'utf8')>8*1024*1024||text.includes('\0'))fail('FILE_SIZE','Use a UTF-8 CSV file no larger than 8 MB, without NUL bytes.')
  const normalized=text.replace(/^\uFEFF/,''),starts=recordLines(normalized,format.delimiter)
  const rows=parseCsv(normalized,format.delimiter),headers=rows[0]?.map(s=>s.trim())??[]
  if(!headers.length||headers.some(s=>!s)||new Set(headers).size!==headers.length)fail('HEADERS','CSV headers must be non-empty and unique.')
  if(rows.length>10001)fail('ROWS','Use at most 10,000 data rows per file.')
  const used=new Set(Object.values(format.columns)),ignored=new Set(format.ignoredColumns)
  if(Object.keys(format.columns).some(k=>!FIELDS[kind].includes(k))||[...used].some(h=>!headers.includes(h))||[...ignored].some(h=>!headers.includes(h))||[...used].some(h=>ignored.has(h)))fail('MAPPING','The field mapping or explicit ignored-column list is invalid.')
  if(used.size!==Object.values(format.columns).length)fail('MAPPING','A source column cannot feed two different fields.')
  const unmapped=headers.filter(h=>!used.has(h)&&!ignored.has(h));if(unmapped.length)fail('UNMAPPED_COLUMNS',`Map or explicitly ignore: ${unmapped.join(', ')}.`)
  const stages:ImportStage[]=[],excluded:Array<{sourceLine:number;reason:string}>=[]
  for(let index=1;index<rows.length;index++) {
    const cells=rows[index],sourceLine=starts[index]
    if(cells.every(s=>!s.trim()))continue
    if(cells.length!==headers.length)fail('ROW_WIDTH',`Source row ${sourceLine} has ${cells.length} columns; expected ${headers.length}.`)
    const get=(field:string,required=false)=>{const header=format.columns[field],v=header?cells[headers.indexOf(header)].trim():'';if(required&&!v)fail('FIELD',`Source row ${sourceLine} requires ${field}.`);const limit=field.startsWith('source_')||field==='target_document_id'?200:1000;if(v.length>limit)fail('FIELD_SIZE',`Source row ${sourceLine} field ${field} is too long.`);return v}
    const rowType=get('row_type')
    if(['subtotal','opening_display'].includes(rowType)){excluded.push({sourceLine,reason:rowType});continue}
    if(rowType && !['transaction','balance','item','account','application'].includes(rowType))fail('ROW_TYPE',`Source row ${sourceLine} has an unsupported row_type.`)
    const amount=()=>{
      if(kind==='general_ledger'||kind==='trial_balance'||kind==='starting_trial_balance') {
        if(format.amountConvention==='debit_credit') {
          if(format.columns.amount||!format.columns.debit||!format.columns.credit)fail('AMOUNT_MAPPING','Choose separate debit/credit columns, without a signed amount column.')
          const debit=get('debit')?importAmount(get('debit'),format.amountFormat):0n,credit=get('credit')?importAmount(get('credit'),format.amountFormat):0n
          if(debit<0n||credit<0n||debit&&credit)fail('DEBIT_CREDIT',`Source row ${sourceLine} needs non-negative debit OR credit, not both.`)
          return String(debit-credit)
        }
        if(format.columns.debit||format.columns.credit)fail('AMOUNT_MAPPING','Signed mode cannot also map debit/credit columns.')
      }
      return String(importAmount(get('amount',true),format.amountFormat))
    }
    const currency=()=>{const v=get('currency',true);if(!/^[A-Z]{3}$/.test(v))fail('CURRENCY',`Source row ${sourceLine} requires an explicit three-letter currency.`);return v}
    if(kind==='accounts') {
      const accountType=get('account_type',true);if(!TYPES.includes(accountType as typeof TYPES[number]))fail('ACCOUNT_TYPE',`Source row ${sourceLine} has an unsupported account type.`)
      stages.push({sourceLine,data:{type:'account',sourceAccount:get('source_account',true),name:get('name',true),accountType:accountType as typeof TYPES[number]}})
    } else if(kind==='trial_balance'||kind==='starting_trial_balance') {
      stages.push({sourceLine,data:{type:'balance',sourceAccount:get('source_account',true),amount:amount()}})
    } else if(kind==='open_items'||kind==='starting_open_items') {
      const direction=get('direction',true),documentKind=get('kind',true),issuedOn=importDate(get('issued_on',true),format.dateFormat),dueOn=get('due_on')?importDate(get('due_on'),format.dateFormat):issuedOn
      if(!['sales','purchase'].includes(direction)||!['invoice','credit_note','unapplied'].includes(documentKind))fail('DOCUMENT_TYPE',`Source row ${sourceLine} has an unsupported direction/kind.`)
      const cents=amount();if(BigInt(cents)<=0n)fail('ITEM_AMOUNT',`Source row ${sourceLine} needs a positive outstanding amount.`)
      if(dueOn<issuedOn)fail('DUE_DATE',`Source row ${sourceLine} has a due date before issue.`)
      stages.push({sourceLine,data:{type:'item',sourceId:get('source_id',true),sourceAccount:get('source_account',true),sourceParty:get('source_party',true),direction:direction as 'sales'|'purchase',kind:documentKind as 'invoice'|'credit_note'|'unapplied',number:get('number',documentKind!=='unapplied'),issuedOn,dueOn,amount:cents,currency:currency()}})
    } else if(kind==='bank_open_items'||kind==='starting_bank_open_items') {
      if(format.amountConvention!=='signed')fail('AMOUNT_MAPPING','Outstanding book bank items require signed amounts.')
      const cents=amount();if(BigInt(cents)===0n)fail('ZERO_LINE',`Source row ${sourceLine} is a zero outstanding bank item.`)
      stages.push({sourceLine,data:{type:'bank_item',sourceId:get('source_id',true),sourceAccount:get('source_account',true),date:importDate(get('date',true),format.dateFormat),amount:cents,currency:currency(),number:get('number'),description:get('description',true)}})
    } else if(kind==='general_ledger') {
      const expectedLines=Number(get('expected_lines',true)),documentType=get('document_type',true),sourceId=get('source_id'),sourceGroup=get('source_group')
      if(!sourceId&&!sourceGroup)fail('GROUP_ID',`Source row ${sourceLine} needs a reliable source_id or explicit source_group.`)
      if(!Number.isSafeInteger(expectedLines)||expectedLines<2||expectedLines>1000)fail('GROUP_SIZE',`Source row ${sourceLine} requires the complete source transaction line count (2–1000).`)
      if(!['journal','payment','sales_invoice','sales_credit','purchase_bill','purchase_credit'].includes(documentType))fail('DOCUMENT_TYPE',`Source row ${sourceLine} must explicitly classify its transaction.`)
      const cents=amount();if(BigInt(cents)===0n)fail('ZERO_LINE',`Source row ${sourceLine} is a zero transaction line.`)
      stages.push({sourceLine,data:{type:'gl',sourceId,sourceGroup,expectedLines,date:importDate(get('date',true),format.dateFormat),sourceAccount:get('source_account',true),sourceParty:get('source_party'),amount:cents,currency:currency(),documentType:documentType as ImportGl['documentType'],number:get('number'),dueOn:get('due_on')?importDate(get('due_on'),format.dateFormat):'',description:get('description',true)}})
    } else {
      const cents=amount();if(BigInt(cents)<=0n)fail('APPLICATION_AMOUNT',`Source row ${sourceLine} needs a positive application amount.`)
      stages.push({sourceLine,data:{type:'application',sourceId:get('source_id',true),sourceTransactionId:get('source_transaction_id',true),targetDocumentId:get('target_document_id',true),amount:cents}})
    }
  }
  return {headers,stages,excluded}
}
