import Link from 'next/link'
import {notFound} from 'next/navigation'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {requireOwner,requireLedger} from '@/lib/gate'
import {accessFor,seatsForEntity} from '@/lib/access'
import {MODULE_PATHS} from '@/lib/nav'
import {localToday} from '@/lib/today'
import {missingRoles} from '@/lib/needed-roles'
import {pendingMigrations} from '@/lib/schema-version'
import {savedCompanySetupPlan,SETUP_STARTS,SETUP_MONTHS} from '@/lib/company-onboarding'
import {PageHeader} from '@/components/PageHeader'
import {Icon} from '@/components/Icon'
import {BUTTON,QUIET,REFUSAL} from '@/lib/ui'
import styles from './GettingStarted.module.css'

export const dynamic='force-dynamic'
type Head={entity_id:string;name:string;code:string;province:string|null;currency:string;standard:string;fy_month:number;fy_day:number;accounts:number;periods:number;year_start:string|null;year_end:string|null;onboarding:unknown}
type Facts={opening:boolean;migration:boolean;bank:boolean;tax:boolean;invoices:boolean;payroll:boolean;assets:boolean;inventory:boolean;projects:boolean}
type Task={id:string;title:string;description:string;href:string;action:string;icon:string;done:boolean;status:string;seat:string;secondary?:{href:string;label:string}}
export default async function GettingStarted({params}:{params:Promise<{ledgerId:string}>}){
 const me=await requireOwner(),{ledgerId}=await params;await requireLedger(ledgerId,'')
 if((await pendingMigrations()).length)return <main className="w-full max-w-6xl px-8 py-6 font-sans"><PageHeader title="Company setup"><Link href={`/ledger/${ledgerId}`} className={QUIET}>Go to Overview</Link></PageHeader><p role="alert" className={`mt-6 ${REFUSAL}`}>Database updates are pending. Ask the administrator to apply them, then return to complete company setup.</p></main>
 const today=localToday(),[head]=await db.execute<Head>(sql`SELECT e.id::text entity_id,e.name,e.code,e.province,l.currency,l.accounting_standard standard,e.fiscal_year_end_month AS fy_month,e.fiscal_year_end_day AS fy_day,
 (SELECT count(*)::int FROM account a WHERE a.entity_id=e.id) accounts,
 (SELECT count(*)::int FROM fiscal_period p WHERE p.ledger_id=l.id AND p.start_date<=${today}::date AND p.end_date>=${today}::date AND p.status='open') periods,
 (SELECT fy.start_date::text FROM fiscal_year fy WHERE fy.ledger_id=l.id AND fy.start_date<=${today}::date AND fy.end_date>=${today}::date LIMIT 1) year_start,
 (SELECT fy.end_date::text FROM fiscal_year fy WHERE fy.ledger_id=l.id AND fy.start_date<=${today}::date AND fy.end_date>=${today}::date LIMIT 1) year_end,
 (SELECT a.after->'onboarding' FROM audit_log a WHERE a.action='create_company' AND a.table_name='entity' AND a.record_id=e.id::text ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1) onboarding
 FROM ledger l JOIN entity e ON e.id=l.entity_id WHERE l.id=${ledgerId}::uuid`)
 if(!head)notFound()
 const seats=seatsForEntity(await accessFor(me),head.entity_id,MODULE_PATHS),plan=savedCompanySetupPlan(head.onboarding),base=`/ledger/${ledgerId}`
 const [facts]=await db.execute<Facts>(sql`SELECT
 EXISTS(SELECT 1 FROM journal_entry j WHERE j.ledger_id=${ledgerId}::uuid AND j.source_type='opening_balance' AND j.status='posted') opening,
 EXISTS(SELECT 1 FROM migration_run m WHERE m.ledger_id=${ledgerId}::uuid AND m.status='active') migration,
 EXISTS(SELECT 1 FROM bank_transaction b JOIN account a ON a.id=b.account_id WHERE a.entity_id=${head.entity_id}::uuid) bank,
 EXISTS(SELECT 1 FROM entity_tax_registration r WHERE r.entity_id=${head.entity_id}::uuid AND r.registered_on<=${today}::date AND (r.ceased_on IS NULL OR r.ceased_on>=${today}::date)) tax,
 EXISTS(SELECT 1 FROM invoice i WHERE i.ledger_id=${ledgerId}::uuid AND i.direction='sales') invoices,
 EXISTS(SELECT 1 FROM payroll_employee p WHERE p.entity_id=${head.entity_id}::uuid) payroll,
 EXISTS(SELECT 1 FROM operations_finance_setting f WHERE f.ledger_id=${ledgerId}::uuid AND f.seat='/assets' AND f.connected_on IS NOT NULL) assets,
 EXISTS(SELECT 1 FROM operations_finance_setting f WHERE f.ledger_id=${ledgerId}::uuid AND f.seat='/inventory' AND f.connected_on IS NOT NULL) inventory,
 EXISTS(SELECT 1 FROM project p WHERE p.entity_id=${head.entity_id}::uuid AND p.deleted_at IS NULL) projects`)
 const opening:Task={id:'opening',title:plan.start==='csv'?'Import and review your opening data':'Review your opening balances',description:plan.start==='fresh'?'For balances already held when these books begin. You can leave this for later when starting a new business.':'Bring over the trial balance, customer and supplier balances. Review the date and totals before posting.',href:base+(plan.start==='csv'?'/opening/migration':'/opening'),action:plan.start==='csv'?'Open CSV migration':'Review opening balances',icon:'Opening balances',done:facts.opening||facts.migration,status:facts.migration?'Import active':facts.opening?'Posted':plan.start==='fresh'?'If needed':'Next',seat:'/opening'}
 const work:Record<string,Task>={
 invoices:{id:'invoices',title:'Create your first invoice',description:'Add a customer, check the invoice style and review your first sales document.',href:base+'/invoices/new',action:'Create invoice',icon:'Invoices',done:facts.invoices,status:facts.invoices?'Created':'Next',seat:'/invoices',secondary:{href:base+'/invoices/templates',label:'Invoice style'}},
 payroll:{id:'payroll',title:'Add your payroll employees',description:'Review payroll accounts, then record employee settings, frequency and opening YTD before running payroll.',href:base+'/payroll/people',action:'Set up employees',icon:'Payroll',done:facts.payroll,status:facts.payroll?'Employee added':'Next',seat:'/payroll'},
 inventory:{id:'inventory',title:'Connect inventory to your books',description:'Review opening stock, funding and the raw material, WIP and finished-goods accounts.',href:base+'/inventory/finance',action:'Review inventory connection',icon:'Inventory',done:facts.inventory,status:facts.inventory?'Connected':'Next',seat:'/inventory'},
 assets:{id:'assets',title:'Connect your fixed-asset register',description:'Review existing assets and their cost and accumulated amortization before connecting to Finance.',href:base+'/assets/finance',action:'Review asset connection',icon:'Fixed assets',done:facts.assets,status:facts.assets?'Connected':'Next',seat:'/assets'},
 projects:{id:'projects',title:'Create your first project',description:'Enable Project in company access when needed, then add a project for tracking its revenue, costs and payments.',href:base+'/projects',action:'Open projects',icon:'Project',done:facts.projects,status:facts.projects?'Project created':'Next',seat:'/projects'},
 }
 const bank:Task={id:'bank',title:'Bring in a bank statement',description:'Review your bank accounts, then upload a CSV statement for matching and reconciliation.',href:base+'/bank',action:'Open bank transactions',icon:'Bank',done:facts.bank,status:facts.bank?'Transactions imported':'Next',seat:'/bank'}
 const tax:Task={id:'tax',title:'Record sales-tax registrations',description:'Set registration dates and account numbers when your business is registered. A business number alone does not create a registration.',href:base+'/tax/registration',action:'Review sales tax',icon:'Sales tax',done:facts.tax,status:facts.tax?'Recorded':'When registered',seat:'/tax'}
 const tasks=[...(plan.start==='fresh'?[]:[opening]),...plan.focus.map(id=>work[id]),bank,tax,...(plan.start==='fresh'?[opening]:[])]
 const canOpen=(task:Task)=>seats.includes(task.seat),next=tasks.find(t=>!t.done&&canOpen(t)&&!['tax'].includes(t.id)&&(t.id!=='opening'||plan.start!=='fresh'))
 const coreMissing=(await missingRoles(ledgerId)).filter(r=>r.stops.some(s=>s.weight==='core'))
 const chartReady=head.accounts>0&&coreMissing.length===0,ready=chartReady&&head.periods>0
 return <main className="w-full max-w-6xl px-8 py-6 font-sans" data-company-setup>
  <PageHeader title="Company setup"><Link href={base} className={QUIET}>Go to Overview</Link></PageHeader>
  <div className={styles.layout}><div>
   <div className={styles.intro}><p className={styles.company}>{head.name}</p><h2>Your books have a place.<br/>Let’s make them yours.</h2><p>Start with the steps that fit your company. Your progress below reflects what is saved in these books.</p>{next&&<Link href={next.href} className={BUTTON}>{next.action}<Icon name="chevron-right"/></Link>}</div>
   <section className={styles.foundation} aria-label="Bookkeeping foundation"><div><span className={styles.check}>{chartReady?'✓':'—'}</span><p><strong>{chartReady?'Starting accounts prepared':'Review your foundational accounts'}</strong><span>{head.accounts} accounts in this company</span></p>{seats.includes('/accounts')&&<Link href={base+'/accounts'}>Review accounts</Link>}</div><div><span className={styles.check}>{head.periods>0?'✓':'—'}</span><p><strong>{head.periods>0?'Current fiscal year prepared':'Review the current fiscal period'}</strong><span>{head.year_start&&head.year_end?`${head.year_start} to ${head.year_end}`:'Create a fiscal year before posting'}</span></p>{seats.includes('/periods')&&<Link href={base+'/periods'}>Review periods</Link>}</div></section>
   <section aria-label="Your next setup steps" className={styles.tasks}><h3>Your next steps</h3><ol>{tasks.map(task=><li key={task.id}><span className={styles.taskIcon}><Icon name={task.icon} width="22" height="22"/></span><div className={styles.taskContent}><div className={styles.taskHeading}><h4>{task.title}</h4><span className={styles.status} data-done={task.done}>{canOpen(task)?task.status:'Not enabled'}</span></div><p>{task.description}</p><div className={styles.links}>{canOpen(task)?<><Link href={task.href}>{task.action}<Icon name="chevron-right"/></Link>{task.secondary&&<Link href={task.secondary.href}>{task.secondary.label}</Link>}</>:me.kind==='superadmin'?<Link href="/settings/company-access">Manage company modules</Link>:<span>Ask the superadmin to enable this company module.</span>}</div></div></li>)}</ol></section>
  </div><aside className={styles.book} aria-label="Company book summary"><Icon name="companies" width="28" height="28"/><p className={styles.caption}>Your company in Banyan</p><h2>{head.name}</h2><p className={styles.code}>{head.code}</p><dl><div><dt>Books</dt><dd>{head.currency} · {head.standard}</dd></div><div><dt>Province</dt><dd>{head.province??'Not recorded'}</dd></div><div><dt>Year end</dt><dd>{SETUP_MONTHS[head.fy_month-1]} {head.fy_day}</dd></div><div><dt>Starting point</dt><dd>{SETUP_STARTS.find(s=>s.id===plan.start)?.title}</dd></div></dl><p className={styles.footnote}>{ready?'Your accounting foundation is prepared.':'Complete the accounting foundation before posting.'} Setup steps can be revisited from Overview.</p>{seats.includes('/records')&&<Link href={base+'/records'}>Company details and branding</Link>}</aside></div>
 </main>
}
