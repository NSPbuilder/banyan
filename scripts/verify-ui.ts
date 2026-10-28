/** UI arithmetic and row identity regression checks; no database, no mocks. */
import assert from 'node:assert/strict'
import { amountInput, journalSummary } from '../src/lib/amount-input'
import { parseMoney } from '../src/lib/money'
import { linesFromJson, lineAccount, lineAmount, lineDescription } from '../src/lib/forms'
import { initialRows, editRow, duplicateRow, moveRowTo, removeRow, typedTotal } from '../src/lib/invoice-rows'

let checks=0
function check(ok:unknown,label:string){assert.ok(ok,label);checks++;console.log('PASS',label)}
const line=(accountId:string,debit='',credit='')=>({accountId,debit,credit})
for(const value of ['0','1.23','-12.34','$1,234.56','90071992547409.93'])check(amountInput(value).cents===parseMoney(value),`exact parser agreement: ${value}`)
for(const value of ['1.234','oops','(','.','-'])check(amountInput(value).cents===null&&!!amountInput(value).error,`invalid input cannot become zero: ${value}`)
const valid=[line('a','100'),line('b','','100')]
check(journalSummary(valid).balanced,'balanced complete entry is ready')
check(!journalSummary([...valid,line('c','1.234')]).balanced,'invalid extra line blocks ready despite equal readable totals')
check(!journalSummary([...valid,line('','20')]).balanced,'unassigned amount cannot be silently dropped by a ready entry')
check(!journalSummary([...valid,line('c','0')]).balanced,'started zero line is incomplete')
check(!journalSummary([line('a','100','100'),...valid]).balanced,'dual-sided imported line is refused')
check(!journalSummary([line('a','100'),line('b','','99.99')]).balanced,'one cent imbalance remains visible')
const exact=journalSummary([line('a','90071992547409.93'),line('b','','90071992547409.93')])
check(exact.balanced&&exact.debit===9007199254740993n,'bigint survives above Number safe range')
const read=linesFromJson(JSON.stringify(valid)).lines
check(read.reduce((sum,l)=>sum+l.amount,0n)===0n&&read.length===2,'UI ready entry agrees with the actual journal form reader')
let state=editRow(initialRows(1),0,'account','a')
state=editRow(editRow(editRow(state,0,'amount','123.45'),0,'gst','6.17'),0,'pst','8.64')
state=duplicateRow(state,0)
check(state.rows[1].key===1&&state.nextKey===2&&state.rows[1].gst==='6.17'&&state.rows[1].pst==='8.64','duplicate keeps tax overrides with a new identity')
state=moveRowTo(state,1,0);state=removeRow(state,0)
check(state.rows.length===1&&state.rows[0].key===1&&state.rows[0].amount==='123.45','duplicate survives reorder and deletion of its source')
const total=typedTotal(state.rows)
check(total.total===12345n&&total.unreadable===0,'copied invoice line remains exact')
check([lineAccount(0),lineAmount(0),lineDescription(0)].every(name=>name.includes('.0.')),'submission fields use current positions, not row keys')
console.log(`Completed ${checks} UI regression checks`)
