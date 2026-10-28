import Link from 'next/link'
import {financeSetting,financeAccounts,financialAccountOptions} from '@/lib/operations-finance'
import {operationsReconciliation,operationsLatestDate,reconciliationHash,operationsJournalEvents} from '@/lib/operations-reconciliation'
import {operationDate} from '@/lib/operations-scope'
import {ledgerHead} from '@/lib/ledger-head'
import {PageHeader} from './PageHeader'
import {DateInput} from './DateInput'
import {ActionForm,type FormAction} from './ActionForm'
import {DataTable,TableViewport} from './Table'
import {OperationsFinanceForm} from './OperationsFinanceForm'
import {formatMoney} from '@/lib/money'
import {FIELD,LABEL,QUIET,BUTTON} from '@/lib/ui'
import type {OperationsSeat,ReconciliationRow,OperationsJournalRow} from '@/lib/operations-finance-types'
import styles from './OperationsFinance.module.css'
export function JournalLink({ledgerId,id,number,reason}:{ledgerId:string;id:string|null;number:string|null;reason?:string|null}) {
 return id?<Link className={styles.journal} href={`/ledger/${ledgerId}/entries/${id}`}>{number??'Open journal'}</Link>:<span className="text-metadata text-ink-muted">{reason??'Before financial connection'}</span>
}
export function ReconciliationTable({rows,currency}:{rows:ReconciliationRow[];currency:string}) {
 return <div className={styles.reconciliation}><TableViewport label="Register to general ledger reconciliation"><DataTable className="ui-table-spaced min-w-176"><thead><tr><th>Stage / account</th><th className={styles.amount}>Register ({currency})</th><th className={styles.amount}>General ledger ({currency})</th><th className={styles.amount}>Difference</th></tr></thead><tbody>{rows.map(r=><tr key={r.key}><td>{r.label}<p className="text-metadata text-ink-muted">{r.account_label??`GIFI ${r.code} · Account setup required`}</p></td><td className={styles.amount}>{formatMoney(BigInt(r.register_amount))}</td><td className={styles.amount}>{formatMoney(BigInt(r.gl_amount))}</td><td className={`${styles.amount} ${BigInt(r.difference)===0n?styles.matched:styles.difference}`}>{formatMoney(BigInt(r.difference))}</td></tr>)}</tbody></DataTable></TableViewport></div>
}
export function OperationsEventTable({ledgerId,events}:{ledgerId:string;events:OperationsJournalRow[]}) {
 return <TableViewport label="Source journals"><DataTable className="ui-table-spaced min-w-160"><thead><tr><th>Date</th><th>Source</th><th>Journal / reason</th></tr></thead><tbody>{events.map(e=><tr key={e.id}><td className="tabular-nums whitespace-nowrap">{e.event_date}</td><td className="capitalize">{e.source_kind.replaceAll('_',' ')}</td><td><JournalLink ledgerId={ledgerId} id={e.entry_id} number={e.entry_no} reason={e.no_entry_reason}/></td></tr>)}{!events.length&&<tr><td colSpan={3} className="py-8 text-center text-ink-muted">No financial sources in this date range.</td></tr>}</tbody></DataTable></TableViewport>
}
export async function OperationsFinanceView({ledgerId,seat,date,initialize,connect,save}:{ledgerId:string;seat:OperationsSeat;date:string;initialize:FormAction;connect:FormAction;save:FormAction}) {
 operationDate(date)
 const [head,cfg,accounts,options,rows,latest]=await Promise.all([ledgerHead(ledgerId),financeSetting(ledgerId,seat),financeAccounts(ledgerId,seat),financialAccountOptions(ledgerId),operationsReconciliation(ledgerId,seat,date),operationsLatestDate(ledgerId,seat)])
 if(!head)return null
 const ready=accounts.every(a=>a.account_id),connected=!!cfg?.connected_on,events=connected?await operationsJournalEvents(ledgerId,seat,cfg!.connected_on!,date):[]
 return <div className={styles.workspace} data-operations-screen="finance"><PageHeader title={seat==='/assets'?'Fixed assets · Finance':'Inventory · Finance'} context={head.entity}/>
  <div className={styles.intro}><p className="text-body text-ink-secondary">{connected?`Connected from ${cfg!.connected_on}. Business records and posted control-account balances are compared at the same day.`:'Review the register against your existing ledger before connecting. Only the confirmed differences will enter the books.'}</p><form method="get"><label className={`${LABEL} inline-flex flex-wrap items-center gap-2`}>As of<DateInput name="date" required defaultValue={date} className={FIELD}/><button className={QUIET}>Review day</button></label></form></div>
  {cfg?.connected_on&&date<cfg.connected_on&&<p className={styles.notice}>This date precedes financial connection. Historical register values are shown without a financial reconciliation claim.</p>}
  {!connected&&latest&&date<latest&&<p className={styles.notice}>Choose a connection date on or after the latest recorded business date, {latest}.</p>}
  <ReconciliationTable rows={rows} currency={head.currency}/>
  {!ready?<ActionForm action={initialize} submit="Initialize GIFI-based module accounts" working="Creating accounts…" buttonClassName={BUTTON}><input type="hidden" name="ledgerId" value={ledgerId}/></ActionForm>:<OperationsFinanceForm key={`${cfg?.version??0}:${date}`} ledgerId={ledgerId} seat={seat} date={date} hash={reconciliationHash(rows,date,latest)} setting={cfg} options={options} action={connected?save:connect}/>}
  {connected&&<section className={styles.section}><h2 className="text-section-title font-semibold">Source journals through {date}</h2><OperationsEventTable ledgerId={ledgerId} events={events}/></section>}
 </div>
}
