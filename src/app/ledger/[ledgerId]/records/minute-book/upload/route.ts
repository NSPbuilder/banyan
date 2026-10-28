import { revalidatePath } from 'next/cache'
import { actorOf, guardRoute } from '@/lib/gate'
import { isSameOriginUpload, readAttachmentUpload, UploadRequestError } from '@/lib/attachment-upload'
import { uploadMinuteBookFromForm } from '@/lib/minute-book-forms'

export async function POST(request: Request, context: { params: Promise<{ ledgerId: string }> }) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  if (!isSameOriginUpload(request)) return Response.json({ error: 'Upload from this Banyan page.' }, { status: 403 })
  const { ledgerId } = await context.params
  let form: FormData
  try { form = await readAttachmentUpload(request) }
  catch (error) {
    if (!(error instanceof UploadRequestError)) throw error
    return Response.json({ error: error.message }, { status: error.status })
  }
  const result = await uploadMinuteBookFromForm(ledgerId, form, actorOf(who))
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/records`)
    revalidatePath(`/ledger/${ledgerId}/records/minute-book`)
  }
  return Response.json(result, { status: result.error ? 422 : 200, headers: { 'cache-control': 'no-store' } })
}
