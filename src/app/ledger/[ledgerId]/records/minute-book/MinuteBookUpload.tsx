'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { DateInput } from '@/components/DateInput'
import { IconButton } from '@/components/IconButton'
import { ATTACHMENT_MAX_BYTES } from '@/lib/forms'
import { BUTTON, FIELD, GHOST, LABEL, REFUSAL, SUCCESS } from '@/lib/ui'
import { MINUTE_FILE_ACCEPT, minuteFileMime, minuteFileSize, minuteKindLabel, type MinuteUploadResult } from '@/lib/minute-book'

type Selection = { file: File; status: 'ready' | 'uploading' | 'done' | 'failed'; error?: string }

/** One multipart request per file; neither a large package nor a signed PDF
 * is serialized through React Flight. The same record id survives retries. */
export function MinuteBookUpload({ ledgerId, minuteId, today, kinds }: {
  ledgerId: string; minuteId?: string; today: string; kinds: string[]
}) {
  const router = useRouter(), form = useRef<HTMLFormElement>(null), input = useRef<HTMLInputElement>(null)
  const requestId = useRef<string | null>(null), confirmedId = useRef<string | null>(minuteId ?? null)
  const submittedMetadata = useRef<FormData | null>(null)
  const [locked, setLocked] = useState(false)
  const [canReplaceFiles, setCanReplaceFiles] = useState(false)
  const [files, setFiles] = useState<Selection[]>([]), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [complete, setComplete] = useState(false)
  const [kind, setKind] = useState(kinds.includes('incorporation') ? 'incorporation' : 'other')
  const [title, setTitle] = useState('')
  const titleEdited = useRef(false)
  const setStatus = (index: number, status: Selection['status'], error?: string) =>
    setFiles(previous => previous.map((item, i) => i === index ? { ...item, status, error } : item))

  const choose = (selected: FileList | null) => {
    if ((locked && !canReplaceFiles) || !selected) return
    const next = Array.from(selected).map(file => ({ file, status: 'ready' as const }))
    if (next.length > 100) { setError('Choose up to 100 files at a time.'); return }
    setFiles(next); setError(''); setComplete(false)
    if (!titleEdited.current && next.length) {
      setTitle(next.length === 1 ? next[0].file.name.replace(/\.[^.]+$/, '').slice(0, 255) : `${minuteKindLabel(kind)} documents`)
    }
  }
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !files.length || complete) return
    const invalid = files.find(({ file }) => !file.size || file.size > ATTACHMENT_MAX_BYTES || !minuteFileMime(file.name))
    if (invalid) { setError(`${invalid.file.name}: choose a supported, nonempty file up to 25 MB.`); return }
    const metadata = submittedMetadata.current ?? new FormData(event.currentTarget)
    if (!confirmedId.current && !String(metadata.get('title') ?? '').trim()) {
      setError('Enter a title for this record.'); return
    }
    submittedMetadata.current = metadata
    setBusy(true); setError(''); setLocked(true); setCanReplaceFiles(false)
    requestId.current ??= crypto.randomUUID()
    let allDone = true
    try {
      for (let index = 0; index < files.length; index++) {
        if (files[index].status === 'done') continue
        setStatus(index, 'uploading')
        const file = files[index].file
        let bytes: ArrayBuffer
        try { bytes = await file.arrayBuffer() }
        catch {
          setStatus(index, 'failed', 'Could not read this file. Choose a fully downloaded local copy, then retry.')
          // No request was sent for this file. A local replacement is safe,
          // while previously confirmed files remain on the same record.
          setCanReplaceFiles(true)
          allDone = false; break
        }
        const data = new FormData()
        const creating = !confirmedId.current
        data.set('mode', creating ? 'create' : 'append')
        data.set('minuteId', confirmedId.current ?? requestId.current)
        if (creating) for (const field of ['recordKind', 'onDate', 'title', 'keptAt', 'note']) data.set(field, String(metadata.get(field) ?? ''))
        data.set('file', new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }))
        let result: MinuteUploadResult
        try {
          const response = await fetch(`/ledger/${encodeURIComponent(ledgerId)}/records/minute-book/upload`, {
            method: 'POST', body: data, credentials: 'same-origin', redirect: 'error',
          })
          if (response.headers.get('content-type')?.includes('application/json')) {
            result = await response.json()
            if (!response.ok && !result.error) throw Error('Unexpected response')
          } else if (response.status === 403) {
            const ray = response.headers.get('cf-ray')?.replace(/[^a-z0-9-]/gi, '').slice(0, 80)
            result = { error: ray ? `Upload blocked (403). Cloudflare reference: ${ray}.` : 'You do not have permission to upload here.' }
          } else if (response.status === 413) result = { error: 'The limit is 25 MB per file.' }
          else if (response.status === 401) result = { error: 'Sign in again to upload.' }
          else throw Error('Unexpected response')
        } catch {
          result = { error: 'Could not confirm this upload. Retry checks the same record and file without adding duplicates.' }
        }
        if (!result.ok || !result.minuteId) {
          setStatus(index, 'failed', result.error ?? 'Could not confirm the upload.')
          allDone = false; break
        }
        confirmedId.current = result.minuteId
        setStatus(index, 'done')
        router.refresh()
      }
      if (allDone) {
        setComplete(true)
        form.current?.dispatchEvent(new Event('figtree:form-saved', { bubbles: true }))
      }
    } finally { setBusy(false) }
  }
  const reset = () => {
    setFiles([]); setError(''); setComplete(false); setLocked(false); setCanReplaceFiles(false)
    requestId.current = null; confirmedId.current = minuteId ?? null
    submittedMetadata.current = null
    titleEdited.current = false; setTitle(''); form.current?.reset()
  }

  return <form ref={form} onSubmit={upload} data-pending={busy ? 'true' : undefined} className="space-y-4" aria-label={minuteId ? 'Attach documents' : 'Add documents'}>
    <input type="hidden" name="ledgerId" value={ledgerId} />
    {minuteId && <input type="hidden" name="minuteId" value={minuteId} />}
    {error && <p role="alert" className={REFUSAL}>{error}</p>}
    {!minuteId && <fieldset disabled={busy || locked} className="grid gap-3 sm:grid-cols-2">
      <label className={LABEL}>Category
        <select name="recordKind" aria-label="Category" value={kind} onChange={e => setKind(e.target.value)} className={`${FIELD} mt-1 block w-full`} required>
          {kinds.map(k => <option key={k} value={k}>{minuteKindLabel(k)}</option>)}
        </select>
      </label>
      <label className={LABEL}>Record date
        <DateInput name="onDate" defaultValue={today} className={`${FIELD} mt-1 block w-full`} required />
      </label>
      <label className={`${LABEL} sm:col-span-2`}>Title
        <input name="title" value={title} onChange={e => { titleEdited.current = true; setTitle(e.target.value) }} maxLength={255} required className={`${FIELD} mt-1 block w-full`} />
      </label>
      <label className={`${LABEL} sm:col-span-2`}>Note
        <textarea name="note" rows={2} maxLength={10000} className={`${FIELD} mt-1 block w-full`} />
      </label>
      <label className={`${LABEL} sm:col-span-2`}>Original location <span className="font-normal text-ink-muted">(optional)</span>
        <input name="keptAt" maxLength={500} placeholder="Banyan" className={`${FIELD} mt-1 block w-full`} />
      </label>
    </fieldset>}
    <div>
      <label className={LABEL}>Files
        <input ref={input} type="file" name="file" multiple accept={MINUTE_FILE_ACCEPT} disabled={busy || (locked && !canReplaceFiles)}
               onChange={e => choose(e.target.files)} className={`${FIELD} mt-1 block w-full file:mr-3 file:border-0 file:bg-transparent file:text-ink`} />
      </label>
      <p className="mt-1 text-caption text-ink-muted">PDF, images, DOCX, XLSX, PPTX and TXT. Up to 25 MB per file.</p>
    </div>
    {files.length > 0 && <ul className="divide-y divide-line-subtle" aria-label="Upload progress">
      {files.map(({ file, status, error }, index) => <li key={`${index}-${file.name}`} className="py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 break-words text-body">{file.name}</span>
          <span className="flex shrink-0 items-center gap-2 text-metadata text-ink-muted" aria-live="polite">
            {status === 'done' ? 'Added' : status === 'uploading' ? 'Uploading…' : status === 'failed' ? 'Failed' : minuteFileSize(file.size)}
            {!locked && <IconButton icon="close" label={`Remove ${file.name}`} onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))} />}
          </span>
        </div>
        {error && <p role="alert" className="mt-1 text-metadata text-danger-ink">{error}</p>}
      </li>)}
    </ul>}
    {complete && <p role="status" className={SUCCESS}>Documents added.</p>}
    <div className="form-actions">
      {!complete && <button type="submit" className={BUTTON} disabled={busy || !files.length}>
        {busy ? 'Uploading…' : files.some(f => f.status === 'failed') ? 'Retry remaining files' : minuteId ? 'Attach documents' : 'Add documents'}
      </button>}
      {complete && <button type="button" className={GHOST} onClick={reset}>{minuteId ? 'Choose more documents' : 'Add another record'}</button>}
    </div>
  </form>
}
