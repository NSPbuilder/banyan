/**
 * Render the picker in each of the shapes the screens use it in, and read the
 * markup back — `verify-picker.ts` runs this.
 *
 * A process of its own, like render-invoice-lines: react-dom/server does not
 * exist under the react-server condition the suites run in.
 *
 *   npx tsx scripts/render-picker.tsx '<json>'
 *   { cases: [...] }  →  { html: { <case name>: '<markup>' } }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { Picker, type PickerCreate, type PickerOption } from '../src/components/Picker'

const input = JSON.parse(process.argv[2]) as {
  cases: Array<{
    as: string
    name?: string
    options: PickerOption[]
    defaultValue?: string
    value?: string
    required?: boolean
    placeholder?: string
    create?: Omit<PickerCreate, 'action'>
  }>
}

const html: Record<string, string> = {}
for (const c of input.cases) {
  html[c.as] = renderToStaticMarkup(
    <Picker
      name={c.name}
      options={c.options}
      defaultValue={c.defaultValue}
      value={c.value}
      required={c.required}
      placeholder={c.placeholder}
      ariaLabel={c.as}
      // The door is never called here: this renders, it does not press.
      create={c.create ? { ...c.create, action: async () => ({}) } : undefined}
      onChange={c.create ? () => {} : undefined}
    />,
  )
}
console.log(JSON.stringify({ html }))
