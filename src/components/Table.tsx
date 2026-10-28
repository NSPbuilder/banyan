import type { HTMLAttributes, TableHTMLAttributes } from 'react'

export function TableColumns({ columns }: {columns: ReadonlyArray<{width: string; className?: string}>}) {
  return <colgroup>{columns.map((column,i)=><col key={i} style={{width:column.width}} className={column.className}/>)}</colgroup>
}

/** The surrounding viewport scrolls; retain native column layout at phone width. */
export function ColumnTable({ columns, children, className = '', style, density = 'reading', ...props }: TableHTMLAttributes<HTMLTableElement> & {
  columns: ReadonlyArray<{width: string; className?: string}>
  density?: 'compact' | 'reading'
}) {
  return <DataTable {...props} density={density} style={{...style,display:'table'}} className={`table-fixed ${className}`}>
    <TableColumns columns={columns}/>{children}
  </DataTable>
}

/** Separate-border tables need rules on cells, rather than on the row. */
export function TableSummaryRow({ children, className = '', ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={`font-semibold [&>th]:border-t [&>td]:border-t [&>th]:border-line [&>td]:border-line ${className}`} {...props}>{children}</tr>
}

/** Only the grid scrolls; the page and its actions keep their place. */
export function TableViewport({ label, children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { label: string }) {
  return <div role="region" aria-label={label} tabIndex={0} data-table-scroll
    className={`table-scroll ui-table-viewport ${className}`} {...props}>{children}</div>
}

export function DataTable({ children, className = '', density = 'compact', ...props }: TableHTMLAttributes<HTMLTableElement> & {
  density?: 'compact' | 'reading'
}) {
  return <table className={`ui-table w-full text-label ${className}`} data-density={density} {...props}>{children}</table>
}
