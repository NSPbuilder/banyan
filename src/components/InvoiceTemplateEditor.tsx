'use client'

import { useRef, useState } from 'react'
import { ActionForm, type FormAction } from './ActionForm'
import { Picker } from './Picker'
import { BUTTON, FIELD, LABEL, QUIET_COMPACT, TOOL_BUTTON } from '@/lib/ui'
import { ToolAction } from './ToolAction'
import { InvoicePaperPreview } from './InvoicePaperPreview'
import { invoiceTemplateSample } from '@/lib/invoice-template-sample'
import { STANDARD_INVOICE_SETTINGS, INVOICE_CONTACT_LIMITS, INVOICE_LOGO_MAX_BYTES, type InvoiceTemplate, type InvoiceTemplateContact } from '@/lib/invoice-template-types'

const contactFields: Array<{name: keyof InvoiceTemplateContact; label: string; type?: string}> = [
  {name: 'city', label: 'City'}, {name: 'province', label: 'Province'}, {name: 'postalCode', label: 'Post code'},
  {name: 'officePhone', label: 'Office phone', type: 'tel'}, {name: 'cellPhone', label: 'Cell phone', type: 'tel'}, {name: 'email', label: 'Email', type: 'email'},
]
const emptyContact: InvoiceTemplateContact = {address: '', city: '', province: '', postalCode: '', officePhone: '', cellPhone: '', email: ''}

export function InvoiceTemplateEditor({ template, companies, today, action, ledgerId, admin = false, previewHref }: {
  template?: InvoiceTemplate; companies?: { id: string; name: string }[]; today: string
  action: FormAction; ledgerId?: string; admin?: boolean; previewHref?: string
}) {
  const [entityId, setEntityId] = useState(companies?.[0]?.id ?? '')
  const [name, setName] = useState(template?.name ?? '')
  const [settings, setSettings] = useState(template?.settings ?? STANDARD_INVOICE_SETTINGS)
  const logoInput = useRef<HTMLInputElement>(null), logoGeneration = useRef(0)
  const [logoError, setLogoError] = useState(''), [readingLogo, setReadingLogo] = useState(false)
  const readLogo = (file?: File) => {
    const generation = ++logoGeneration.current
    setLogoError(''); setReadingLogo(false)
    if (!file) return
    if (file.size > INVOICE_LOGO_MAX_BYTES || !['image/png', 'image/jpeg'].includes(file.type)) {
      setLogoError('Choose a PNG or JPEG logo up to 256 KB. Export Illustrator artwork as an image first.')
      if (logoInput.current) logoInput.current.value = ''
      return
    }
    const reader = new FileReader(); setReadingLogo(true)
    reader.onload = () => {if (logoGeneration.current === generation) {setSettings(s => ({...s, logoDataUrl: String(reader.result)})); setReadingLogo(false)}}
    reader.onerror = () => {if (logoGeneration.current === generation) {setLogoError('The logo could not be read. Choose the file again.'); setReadingLogo(false); if (logoInput.current) logoInput.current.value = ''}}
    reader.readAsDataURL(file)
  }
  const contact = settings.contact ?? emptyContact
  const changeContact = (name: keyof InvoiceTemplateContact, value: string) => setSettings(s => ({...s, contact: {...emptyContact, ...s.contact, [name]: value}}))
  const companyName = template?.owner_name ?? companies?.find(c => c.id === entityId)?.name ?? 'Your company'
  return <ActionForm action={action} submit={template ? 'Save template' : 'Create template'} working="Saving…"
    buttonClassName={BUTTON} onSucceeded={!template ? () => { ++logoGeneration.current; setName(''); setSettings({ ...STANDARD_INVOICE_SETTINGS }); setLogoError(''); setReadingLogo(false) } : undefined} stickyActions secondaryActions={previewHref && <a href={previewHref} target="_blank" rel="noopener noreferrer" className={TOOL_BUTTON} title="Preview PDF"><ToolAction kind="pdf">Preview PDF</ToolAction></a>}>
    {template && <><input type="hidden" name="templateId" value={template.id} /><input type="hidden" name="version" value={template.current_version} /></>}
    {ledgerId && <input type="hidden" name="ledgerId" value={ledgerId} />}
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)]">
      <div className="min-w-0 space-y-3">
        <label className={LABEL}><span>Name</span><input name="name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} className={`mt-1 w-full ${FIELD}`} /></label>
        {template ? <div><p className={LABEL}>Owned by</p><p className="mt-1 text-body">{template.owner_name}</p><p className="mt-1 text-metadata text-ink-muted">v{template.current_version}</p></div>
          : <div className={LABEL}><span>Owned by</span><Picker name="entityId" required ariaLabel="Owned by" className="mt-1" value={entityId} onChange={setEntityId} options={(companies ?? []).map(c => ({ id: c.id, label: c.name }))} /></div>}
        <label className={LABEL}><span>Layout</span><select name="layout" aria-label="Layout" value={settings.layout} onChange={e => setSettings(s => ({ ...s, layout: e.target.value as typeof s.layout }))} className={`mt-1 w-full ${FIELD}`}><option value="standard">Standard</option><option value="compact">Compact</option></select></label>
        <label className={LABEL}><span>Payment instructions</span><textarea name="paymentInstructions" rows={3} maxLength={4000} value={settings.paymentInstructions} onChange={e => setSettings(s => ({ ...s, paymentInstructions: e.target.value }))} className={`mt-1 w-full ${FIELD}`} /></label>
        <label className={LABEL}><span>Footer</span><textarea name="footer" rows={2} maxLength={2000} value={settings.footer} onChange={e => setSettings(s => ({ ...s, footer: e.target.value }))} className={`mt-1 w-full ${FIELD}`} /></label>
        <section className="space-y-3 border-t border-line-subtle pt-3" aria-label="Branding and contact information">
          <h2 className="text-section-title font-semibold">Branding and contact</h2>
          <p className="text-metadata text-ink-muted">Company name comes from the company record. Blank address fields use the registered address.</p>
          <input type="hidden" name="logoDataUrl" value={settings.logoDataUrl ?? ''} />
          <label className={LABEL}><span>Company logo</span><input ref={logoInput} type="file" name="logo" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={e => readLogo(e.target.files?.[0])} className={`mt-1 w-full ${FIELD}`} /></label>
          <p className="text-metadata text-ink-muted">PNG or JPEG, up to 256 KB and 2 megapixels. Export .ai artwork as an image first.</p>
          {readingLogo && <p role="status" className="text-metadata text-ink-muted">Loading logo preview…</p>}
          {logoError && <p role="alert" className="text-metadata text-danger">{logoError}</p>}
          {settings.logoDataUrl && <button type="button" className={QUIET_COMPACT} onClick={() => {++logoGeneration.current; setReadingLogo(false); setLogoError(''); setSettings(s => ({...s, logoDataUrl: ''})); if (logoInput.current) logoInput.current.value = ''}}>Remove logo</button>}
          <label className={LABEL}><span>Address</span><textarea name="address" rows={2} maxLength={INVOICE_CONTACT_LIMITS.address} value={contact.address} onChange={e => changeContact('address', e.target.value)} className={`mt-1 w-full ${FIELD}`} /></label>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">{contactFields.map(field => <label key={field.name} className={`${LABEL} min-w-0 ${field.name === 'email' ? 'sm:col-span-2' : ''}`}><span>{field.label}</span><input name={field.name} type={field.type ?? 'text'} maxLength={INVOICE_CONTACT_LIMITS[field.name]} value={contact[field.name]} onChange={e => changeContact(field.name, e.target.value)} className={`mt-1 w-full ${FIELD}`} /></label>)}</div>
        </section>
        {admin && template ? <label className="flex min-h-control items-center gap-2 text-label"><input name="isActive" type="checkbox" defaultChecked={template.is_active} />Available for new invoices</label> : <input type="hidden" name="isActive" value="on" />}
        {template && <p className="text-metadata text-ink-muted">Changes apply to future invoices in every company using this template.</p>}
      </div>
      <section className="min-w-0" aria-label="Sample invoice preview">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-section-title font-semibold">Sample preview</h2><span className="text-metadata text-ink-muted">Letter · 8.5 × 11 in</span></div>
        <div className="min-w-0 rounded-panel border border-line-subtle bg-surface p-4">
          <InvoicePaperPreview doc={invoiceTemplateSample(companyName, today, { templateId: template?.id ?? null, name: name || 'New template', version: template?.current_version ?? 1, settings })} />
        </div>
      </section>
    </div>
  </ActionForm>
}
