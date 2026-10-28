'use client'

import { ActionForm } from '@/components/ActionForm'
import type { FormState } from '@/app/actions'
import { ATTACHMENT_MAX_BYTES } from '@/lib/forms'
import { useRouter } from 'next/navigation'

export function AttachmentUpload({ ledgerId, entryId }: {
  ledgerId: string; entryId: string
}) {
  const router = useRouter()
  const upload = async (_previous: FormState, formData: FormData): Promise<FormState> => {
    const file = formData.get('file')
    if (file instanceof File && file.size > ATTACHMENT_MAX_BYTES) {
      return { error: 'The file is too large. The limit is 25 MB.' }
    }
    // Disk-backed selections can become unreadable while a cloud provider
    // downloads or replaces them. Send a byte snapshot, keeping signed PDFs
    // untouched. The server independently enforces the same size limit.
    if (file instanceof File && file.size > 0) {
      try {
        formData.set('file', new File([await file.arrayBuffer()], file.name, {
          type: file.type, lastModified: file.lastModified,
        }))
      } catch {
        return { error: 'Could not read this file. Download it fully or copy it to a local folder, then choose it again.' }
      }
    }
    const response = await fetch(`/ledger/${encodeURIComponent(ledgerId)}/attachments/upload`, {
      method: 'POST', body: formData, credentials: 'same-origin', redirect: 'error',
    })
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result = await response.json()
      if (typeof result?.error === 'string') return { error: result.error }
      if (response.ok && typeof result?.ok === 'string') return { ok: result.ok }
    }
    if (response.status === 401) return { error: 'Sign in again, then upload the file.' }
    if (response.status === 403) {
      const ray = response.headers.get('cf-ray')?.replace(/[^a-z0-9-]/gi, '').slice(0, 80)
      return { error: ray ? `The upload was blocked (403). Cloudflare reference: ${ray}.`
        : 'You do not have permission to upload to this entry.' }
    }
    if (response.status === 413) return { error: 'The file is too large. The limit is 25 MB.' }
    // Unknown responses may follow a committed upload; keep the selection
    // and use the existing recovery message without submitting a second time.
    throw new Error('Unconfirmed attachment response')
  }

  return (
    <ActionForm action={upload} submit="Attach" working="Filing…"
                onSucceeded={() => router.refresh()}
                requestError="Could not confirm the upload. Reload this entry to check whether it was attached before trying again."
                buttonClassName="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
      <input type="hidden" name="ledgerId" value={ledgerId} />
      <input type="hidden" name="entryId" value={entryId} />
      <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.tiff,application/pdf,image/*"
             className="block text-xs text-neutral-600 file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-xs dark:text-neutral-400 dark:file:border-neutral-700" />
    </ActionForm>
  )
}
