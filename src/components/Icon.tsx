import type { SVGProps } from 'react'

/** One outline icon catalogue for application navigation and controls. */
const paths: Record<string, string> = {
  reset: 'M3 11a9 9 0 1 1 2.7 7 M3 4v7h7',
  Project: 'M3 20h18 M5 17v-4a7 7 0 0 1 14 0v4 M3 17h18 M10 6V3h4v3 M8 9v4 M16 9v4',
  Inventory: 'm3 7 9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10 M7.5 5l9 4',
  'Fixed assets': 'M3 21h18 M5 21V8l7-5 7 5v13 M9 21v-6h6v6 M9 9h.01 M15 9h.01',
  Manage: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  Overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  Search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z m6-2 4 4',
  CRM: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  Expenses: 'M3 10h18v11H3z M12 13a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M6 14v3 M18 14v3 M12 7V2 m-3 3 3-3 3 3',
  Cheques: 'M3 5h18v14H3z M6 9h6 M16 9h2 M6 14h3 m3 2 2-3 2 2 2-1',
  Income: 'M3 10h18v11H3z M12 13a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M6 14v3 M18 14v3 M12 2v5 m-3-3 3 3 3-3',
  Invoices: 'M6 2h9l5 5v15H6z M14 2v6h6 M9 12h7 M9 16h7',
  Bank: 'M3 10h18 M5 10v9 M10 10v9 M14 10v9 M19 10v9 M3 21h18 M12 3 2 9h20z',
  'Journal entries': 'M4 4h16v16H4z M4 9h16 M9 9v11 M13 13h4 M13 17h4',
  Parties: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.87',
  Accounts: 'M3 7 12 3l9 4-9 4z M3 12l9 4 9-4 M3 17l9 4 9-4',
  Reports: 'M4 20V10h4v10 M10 20V4h4v16 M16 20v-7h4v7 M2 20h20',
  'Sales tax': 'M5 19 19 5 M8 8a2 2 0 1 0-4 0 2 2 0 0 0 4 0z M20 17a2 2 0 1 0-4 0 2 2 0 0 0 4 0z',
  Payroll: 'M4 20v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2 M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  'Corporate records': 'M3 7h18v14H3z M8 7V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3 M3 13h18',
  'Periods & year-end': 'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M9 15h3',
  'Opening balances': 'M4 4v6h6 M4 10a8 8 0 1 1 1 7 M12 8v5l3 2',
  'SR&ED': 'm12 2 2.1 6.9L21 11l-6.9 2.1L12 20l-2.1-6.9L3 11l6.9-2.1z',
  Backup: 'M8 19H6a4 4 0 0 1-1-7.87A7 7 0 0 1 18.9 11 4 4 0 0 1 18 19h-2 M12 21V11 m-3 3 3-3 3 3',
  Settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1.4 1.6h-3.2A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 13.6v-3.2A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88L4.2 7.06 7.06 4.2l.06.06A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10.4 3h3.2A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.6 1.4v3.2a1.7 1.7 0 0 0-1.6 1.4z',
  companies: 'M3 21V3h12v18 M15 9h6v12 M7 7h4 M7 11h4 M7 15h4 M7 21v-3h4v3 M19 13v1 M19 17v1',
  audit: 'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h3 M3 7h3 M3 11h3 M3 15h3',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  close: 'm6 6 12 12 M6 18 18 6',
  plus: 'M12 5v14 M5 12h14',
  sparkles: 'm12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 6 6 6-6 6',
  grip: 'M8 5h.01 M16 5h.01 M8 12h.01 M16 12h.01 M8 19h.01 M16 19h.01',
  'sidebar-expand': 'M3 4h18v16H3z M9 4v16 m4-7 3 3-3 3',
  'sidebar-collapse': 'M3 4h18v16H3z M9 4v16 m7-7-3 3 3 3',
  back: 'm14 5-7 7 7 7 M7 12h14',
  print: 'M7 8V3h10v5 M7 17H4V9h16v8h-3 M7 14h10v7H7z M17 11h.01',
  download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  duplicate: 'M8 8h13v13H8z M16 8V3H3v13h5',
  delete: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  alert: 'M12 3 2 21h20z M12 9v5 M12 17h.01',
  file: 'M14 3H5v18h14V8z M14 3v5h5 M12 11v7 m-3-3 3 3 3-3',
}

export function Icon({ name, className = '', ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none"
              stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
              className={`ui-icon ${className}`} {...props}><path d={paths[name] ?? paths.Invoices} /></svg>
}
