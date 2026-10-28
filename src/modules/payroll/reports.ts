import 'server-only'
import { ledgerHead as ledgerHeader } from '@/lib/ledger-head'
import { csvFile, csvMoney } from '@/lib/csv'
import { remittanceMonths } from '@/lib/payroll/runs'

export async function pd7aCsv(ledgerId: string, year: number) {
  const head = await ledgerHeader(ledgerId)
  if (!head) return null
  const months = await remittanceMonths(ledgerId, year)
  const rows: Array<Array<string | number>> = [
    [head.entity, `PD7A remittances ${year}`, 'by month of pay date', head.currency],
    [],
    ['Month', 'Remit by', 'Runs', 'Employees', 'Gross payroll', 'CPP', 'EI', 'Tax', 'Current payment'],
  ]
  const sum = { gross: 0n, cpp: 0n, ei: 0n, tax: 0n, total: 0n }
  for (const m of months) {
    rows.push([m.month, m.dueOn, m.runs, m.employees, csvMoney(m.gross), csvMoney(m.cpp), csvMoney(m.ei), csvMoney(m.incomeTax), csvMoney(m.total)])
    sum.gross += m.gross; sum.cpp += m.cpp; sum.ei += m.ei; sum.tax += m.incomeTax; sum.total += m.total
  }
  rows.push([], ['Total', '', '', '', csvMoney(sum.gross), csvMoney(sum.cpp), csvMoney(sum.ei), csvMoney(sum.tax), csvMoney(sum.total)])
  return { csv: csvFile(rows), rows, entity: head.entity }
}
