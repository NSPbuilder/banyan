import 'server-only'
import {sql} from 'drizzle-orm'
import type {Tx} from './acting'

/** Every accounting door takes the source lock before document/entry locks. */
export const lockInvoiceProject=(tx:Tx,invoiceId:string)=>tx.execute(sql`
  SELECT p.id FROM project p JOIN project_accounting_link h ON h.project_id=p.id
  WHERE h.invoice_id=${invoiceId}::uuid ORDER BY p.id FOR UPDATE OF p`)
export const lockPaymentProjects=(tx:Tx,entryId:string)=>tx.execute(sql`
  SELECT p.id FROM project p WHERE p.id IN (
    SELECT project_id FROM project_accounting_payment WHERE entry_id=${entryId}::uuid
    UNION SELECT h.project_id FROM project_accounting_link h JOIN invoice_application a ON a.invoice_id=h.invoice_id WHERE a.entry_id=${entryId}::uuid)
  ORDER BY p.id FOR UPDATE OF p`)
