'use server'

import { requireUser } from '@/lib/gate'
import {
  revokeWebDavCredential, rotateWebDavCredential, WebDavError,
} from '@/lib/webdav-credentials'

type WebDavState = { active: boolean; secret?: string; error?: string }

export async function webdavCredentialAction(
  previous: WebDavState, formData: FormData,
): Promise<WebDavState> {
  const user = await requireUser()
  const entityId = String(formData.get('entityId') ?? '')
  const intent = String(formData.get('intent') ?? '')
  try {
    if (intent === 'rotate') {
      const secret = await rotateWebDavCredential(user, entityId)
      return { active: true, secret }
    }
    if (intent === 'revoke') {
      await revokeWebDavCredential(user, entityId)
      return { active: false }
    }
    return { ...previous, error: 'Choose a WebDAV action.' }
  } catch (error) {
    if (error instanceof WebDavError) return { ...previous, error: error.message }
    throw error
  }
}
