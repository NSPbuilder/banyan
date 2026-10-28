import { TAX_FIELDS as F } from '@/lib/forms'
import { FIELD } from '@/lib/ui'

/**
 * One proposed account: its code and its name, both editable.
 *
 * In its own file, importing nothing that touches the server, so a check can
 * render it and read back the field names it actually emits. That is the whole
 * reason it is separate: while these two inputs lived inside `RegisterForm`
 * alongside the server action, nothing could render them, and changing the code
 * input's `name` to the name field's — a one-token slip — silently threw away
 * every code the owner typed and created the proposed defaults instead, with
 * every check green.
 *
 * The two inputs are generated from one list rather than written out twice, so
 * the field a box posts under and the value it starts with come from the same
 * word. They cannot disagree.
 */
const FIELDS = [
  { key: 'code' as const, label: 'Code', className: 'w-24 font-mono' },
  { key: 'name' as const, label: 'Name', className: 'w-full' },
]

const input = FIELD
const label = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

export type ProposedRow = {
  code: string; name: string; role: string; accountType: string; why: string
  /** Already in the chart with this role: it will be reused, not created. */
  existing?: { code: string; name: string }
}

export function AccountRow({ row, index, tax }: { row: ProposedRow; index: number; tax: string }) {
  // An account already carrying this role is reused, and nothing typed here
  // would be used. Say so instead of offering boxes that are ignored.
  if (row.existing) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-mono">{row.existing.code}</span>
        <span>{row.existing.name}</span>

      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      {/* What this row is, travelling with it. The handler matches on this
          rather than on position, so nothing that reorders the rows can put a
          code on the wrong account. */}
      <input type="hidden" name={F.role(index)} value={row.role} />
      {FIELDS.map((f) => (
        <div key={f.key} className={f.key === 'name' ? 'flex-1' : undefined}>
          <label htmlFor={`${f.key}${index}-${tax}`} className={label}>{f.label}</label>
          <input
            id={`${f.key}${index}-${tax}`}
            name={F[f.key](index)}
            required
            defaultValue={row[f.key]}
            className={`mt-1 ${f.className} ${input}`}
          />
        </div>
      ))}
      <p className="w-full text-xs text-neutral-500">
        <span className="uppercase tracking-wide">{row.accountType}</span> — {row.why}
      </p>
    </div>
  )
}
