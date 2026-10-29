import { revalidatePath } from 'next/cache'
import { actorOf, guardRoute } from '@/lib/gate'
import { uploadAttachmentFromForm } from '@/lib/attach-forms'
import { isSameOriginUpload, readAttachmentUpload, UploadRequestError } from '@/lib/attachment-upload'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const options = { headers: { 'cache-control': 'no-store' } }

/** A file upload is multipart HTTP, separate from React's Server Actions. */
export async function POST(request: Request, context: { params: Promise<{ ledgerId: string }> }) {
  // The existing attachment path is granted to Journal entries OR Invoices.
  // Authenticate and authorize before reading any of the document bytes.
  const who = await guardRoute()
  if (who instanceof Response) return who
  if (!isSameOriginUpload(request)) {
    return Response.json({ error: 'Upload from this Banyan page.' }, { ...options, status: 403 })
  }
  const { ledgerId } = await context.params
  if (!UUID.test(ledgerId)) {
    return Response.json({ error: 'That request did not name a company.' }, { ...options, status: 400 })
  }
  let formData: FormData
  try {
    formData = await readAttachmentUpload(request)
  } catch (error) {
    if (!(error instanceof UploadRequestError)) throw error
    return Response.json({ error: error.message }, { ...options, status: error.status })
  }
  const entryId = String(formData.get('entryId') ?? '')
  if (!UUID.test(entryId)) {
    return Response.json({ error: 'Choose an entry to attach this file to.' }, { ...options, status: 400 })
  }
  // A form cannot swap in another ledger. saveAttachment also verifies that
  // the entry belongs to this URL's ledger before writing its blob or row.
  formData.set('ledgerId', ledgerId)
  const result = await uploadAttachmentFromForm(formData, actorOf(who))
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/entries/${entryId}`)
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}/invoices`)
    revalidatePath(`/ledger/${ledgerId}`)
  }
  return Response.json(result, { ...options, status: result.error ? 422 : 200 })
}
