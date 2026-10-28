'use client'

import type { InvoiceDocument } from '@/lib/customer-docs'
import { DocHeader } from '@/components/DocHeader'
import { invoiceContactLines, invoiceLogoDataUrl } from '@/lib/invoice-template-types'
import { invoiceAmount, invoiceDate, invoicePaper } from '@/lib/invoice-paper'
import styles from './InvoiceDocView.module.css'

/** Both the live preview and PDF use the same document and presentation data. */
export function InvoiceDocView({ doc, pdfHref, printPdfHref, controls = true }: { doc: InvoiceDocument; pdfHref?: string; printPdfHref?: string; controls?: boolean }) {
  const compact = doc.template?.settings.layout === 'compact'
  const logo = invoiceLogoDataUrl(doc.template?.settings)
  const paper = invoicePaper(doc)
  return <div>
    {controls && <DocHeader pdfHref={pdfHref} printPdfHref={printPdfHref} />}
    <article className={`${styles.paper} ${compact ? styles.compact : ''}`} data-invoice-doc={doc.kind} data-invoice-layout={compact ? 'compact' : 'standard'}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <h1 className={styles.title}>{doc.title}</h1>
          <dl className={styles.metadata}>
            {doc.receipt ? <>
              {doc.receipt.invoiceNumber && <><dt>Invoice number</dt><dd className={styles.number}>{doc.receipt.invoiceNumber}</dd></>}
              <dt>Date paid</dt><dd>{invoiceDate(doc.receipt.paidOn)}</dd>
            </> : <>
            <dt>{doc.kind === 'credit_note' ? 'Credit note number' : 'Invoice number'}</dt><dd className={styles.number}>{doc.number ?? 'Unnumbered'}</dd>
            <dt>Date of issue</dt><dd>{invoiceDate(doc.issuedOn)}</dd>
            {doc.kind === 'invoice' && <><dt>Date due</dt><dd>{invoiceDate(doc.dueOn)}</dd></>}
            </>}
          </dl>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- Embedded logo data URLs also render as standalone invoice paper without a Next image server. */}
        {logo && <div className={styles.logo}><img src={logo} alt={`${doc.company.name} logo`} /></div>}
      </header>
      <section className={styles.addresses} aria-label="Company and customer">
        <div className={styles.address}>
          <p className={styles.company}>{doc.company.name}</p>
          {invoiceContactLines(doc.template?.settings, doc.company.addressLines).map((line, i) => <p key={i}>{line}</p>)}
          {doc.company.taxNumbers.length > 0 && <div className={styles.taxNumbers}>{doc.company.taxNumbers.map(t => <p key={t} data-tax-number>{t}</p>)}</div>}
        </div>
        <div className={styles.address}>
          <h2>{doc.receipt?.direction === 'paid' ? 'Paid to' : doc.kind === 'credit_note' ? 'Credit to' : 'Bill to'}</h2>
          <p>{doc.billTo.name}</p>
          {doc.billTo.addressLines.map((line, i) => <p key={i}>{line}</p>)}
          {(doc.billTo.contactLines ?? []).map((line, i) => <p key={`contact-${i}`}>{line}</p>)}
        </div>
      </section>
      <p className={styles.headline}>{paper.headline}</p>
      <table className={styles.items} aria-label="Invoice items">
        <thead><tr><th scope="col">Description</th><th scope="col" className={styles.amount}>Amount</th></tr></thead>
        <tbody>{paper.items.map((line, i) => <tr key={i}>
          <td className={styles.description}>{line.description || '-'}</td>
          <td className={styles.amount}>{invoiceAmount(line.amount,doc.currency)}</td>
        </tr>)}</tbody>
      </table>
      <dl className={styles.summary} aria-label="Invoice totals">
        {paper.summary.map((row, i) => <div key={i} className={`${styles.summaryRow} ${row.emphasis ? styles.emphasis : ''} ${row.balance ? styles.balance : ''}`}>
          <dt>{row.label}</dt>
          <dd data-doc-total={row.label === 'Total' ? '' : undefined} data-doc-balance={row.balance ? '' : undefined}>{invoiceAmount(row.amount,doc.currency)}</dd>
        </div>)}
      </dl>
      {doc.payments.length > 0 && <section className={styles.payments}>
        <h2>{doc.receipt ? 'Payment history' : doc.kind === 'credit_note' ? 'Credit applications' : 'Payments received'}</h2>
        <table className={styles.items} aria-label="Payment history">
          <thead><tr><th scope="col">Date</th>{!doc.receipt && <th scope="col">Reference</th>}<th scope="col" className={styles.amount}>{doc.receipt ? 'Amount paid' : 'Amount'}</th></tr></thead>
          <tbody>{doc.payments.map((payment, i) => <tr key={i}><td>{invoiceDate(payment.on)}</td>{!doc.receipt && <td className={styles.description}>{payment.what}</td>}<td className={styles.amount}>{invoiceAmount(payment.amount,doc.currency)}</td></tr>)}</tbody>
        </table>
      </section>}
      {!doc.receipt&&doc.kind==='invoice'&&typeof doc.template?.paymentStages==='string'&&doc.template.paymentStages&&<section className={styles.note} aria-label="Payment stages"><h2>Payment stages</h2><p>{doc.template.paymentStages}</p></section>}
      {doc.template?.settings.paymentInstructions && <section className={styles.note}><h2>Payment instructions</h2><p>{doc.template.settings.paymentInstructions}</p></section>}
      {doc.template?.settings.footer && <footer className={styles.footer}>{doc.template.settings.footer}</footer>}
    </article>
  </div>
}
