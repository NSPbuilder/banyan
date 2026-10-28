'use client'
import Link from 'next/link'
import {usePathname} from 'next/navigation'
import styles from './OperationsWorkspace.module.css'
export function OperationsWorkspace({children}:{children:React.ReactNode}){return <div className={styles.workspace} data-operations-workspace>{children}</div>}
export function OperationsTabs({ledgerId,module}:{ledgerId:string;module:'inventory'|'assets'}) {
  const base=`/ledger/${ledgerId}/${module}`,pathname=usePathname(),tabs=module==='inventory'?[['Stock',''],['Production','/production'],['BOMs','/boms'],['Movements','/movements'],['Warehouses','/warehouses'],['Finance','/finance'],['Reports','/reports']]:[['Register',''],['Book depreciation','/depreciation'],['CCA','/cca'],['Deferred tax','/deferred-tax'],['Finance','/finance']]
  const selected=tabs.find(([,path])=>path&&pathname.startsWith(base+path))?.[1]??''
  return <nav aria-label={module==='inventory'?'Inventory views':'Fixed asset views'} className={`${styles.tabs} print:hidden`}>{tabs.map(([text,path])=><Link key={path} href={base+path} className={styles.tab} aria-current={selected===path?'page':undefined}>{text}</Link>)}</nav>
}
export function ProductionFlow({currency,stages}:{currency:string;stages:{label:string;value:string;detail:string}[]}){return <section className={styles.flow} aria-label="Inventory production stages">{stages.map(s=><article key={s.label} className={styles.stage}><p className="text-label font-medium">{s.label}</p><div className={styles.stageValue}>{s.value}</div><p className={styles.stageMeta}>{s.detail} · {currency}</p></article>)}</section>}
export function RegisterSummary({label,values}:{label:string;values:{label:string;value:string}[]}){return <dl className={styles.summary} aria-label={label}>{values.map(v=><div key={v.label}><dt>{v.label}</dt><dd>{v.value}</dd></div>)}</dl>}
