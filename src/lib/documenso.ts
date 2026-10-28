import 'server-only'
import type { Recipient, SigningSnapshot, SigningStatus } from './esign-types'

export const DOCUMENSO_HOST = 'https://app.documenso.com'
const BASE = DOCUMENSO_HOST + '/api/v2'
export class DocumensoError extends Error {
  constructor(readonly ambiguous: boolean, message: string, readonly status?: number) { super(message); this.name = 'DocumensoError' }
}
export type ProviderFetch = typeof fetch
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DocumensoError(true, 'Documenso returned an unexpected response. Refresh to reconcile the request.')
  return v as Record<string, unknown>
}
const string = (v: unknown, max = 1000) => typeof v === 'string' ? v.slice(0, max) : ''
const array = (v: unknown) => Array.isArray(v) ? v : []
const number = (v: unknown) => {
  if (v == null || v === '' || !Number.isFinite(Number(v))) throw new DocumensoError(true, 'Documenso returned an invalid field or recipient reference.')
  return Number(v)
}
export function envelopeId(value: string) {
  if (!/^envelope_[a-zA-Z0-9_-]{1,150}$/.test(value)) throw new DocumensoError(true, 'That Documenso envelope identifier is invalid.')
  return value
}
export function snapshotOf(value: unknown): SigningSnapshot {
  const v = object(value), team = object(v.team)
  const status = string(v.status) as SigningStatus
  if (!['DRAFT', 'PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(status) || v.type !== 'DOCUMENT')
    throw new DocumensoError(true, 'Documenso returned an unsupported document state.')
  const teamUrl = string(team.url, 200)
  if (!/^[a-zA-Z0-9_-]+$/.test(teamUrl)) throw new DocumensoError(true, 'Documenso returned an invalid team address.')
  return {
    id: envelopeId(string(v.id)), externalId: string(v.externalId) || null, status, title: string(v.title, 255), teamUrl,
    completedAt: string(v.completedAt) || null,
    // Explicit allowlist: never persist signing tokens, signature images, or arbitrary provider data.
    recipients: array(v.recipients).map(raw => { const r = object(raw); return { id: number(r.id), name: string(r.name, 255), email: string(r.email, 254), role: string(r.role), signingStatus: string(r.signingStatus), signingOrder: r.signingOrder == null ? null : number(r.signingOrder), signedAt: string(r.signedAt) || null } }),
    items: array(v.envelopeItems).map(raw => { const r = object(raw); return { id: string(r.id, 200), title: string(r.title, 255) } }),
    fields: array(v.fields).map(raw => { const r = object(raw); return { id: number(r.id), recipientId: number(r.recipientId), itemId: string(r.envelopeItemId, 200), type: string(r.type), page: number(r.page), x: number(r.positionX), y: number(r.positionY), width: number(r.width), height: number(r.height) } }),
  }
}
export function editorUrl(request: { remote_id: string | null; team_url: string | null }) {
  if (!request.remote_id || !request.team_url || !/^[a-zA-Z0-9_-]+$/.test(request.team_url)) return null
  return `${DOCUMENSO_HOST}/t/${encodeURIComponent(request.team_url)}/documents/${encodeURIComponent(envelopeId(request.remote_id))}`
}
export function documenso(apiKey: string, send: ProviderFetch = fetch) {
  async function call(path: string, init: RequestInit = {}) {
    let response: Response
    try {
      response = await send(BASE + path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: apiKey }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) })
    } catch { throw new DocumensoError(true, 'Documenso could not be reached. Refresh to reconcile before trying again.') }
    if (!response.ok) {
      // Provider errors may echo secrets or document contents. Keep the response body out of UI/logs.
      const message = response.status === 401 || response.status === 403 ? 'Documenso refused access. The owner should check the team API token and plan.'
        : response.status === 429 ? 'Documenso has reached a rate or plan limit. Try again later after checking the account.'
        : `Documenso returned HTTP ${response.status}. Refresh the request to reconcile its status.`
      throw new DocumensoError(response.status >= 500 || response.status === 408 || response.status === 409, message, response.status)
    }
    return response
  }
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await call(path, init)
    try { return await response.json() } catch { throw new DocumensoError(true, 'Documenso returned an unreadable response. Refresh to reconcile the request.') }
  }
  return {
    async check() { object(await json('/envelope?type=DOCUMENT&perPage=1')) },
    async create(input: { title: string; reference: string; filename: string; bytes: Buffer; recipients: Recipient[]; sequential: boolean }) {
      const form = new FormData()
      form.set('payload', JSON.stringify({ type: 'DOCUMENT', title: input.title, externalId: input.reference, recipients: input.recipients,
        meta: { language: 'en', timezone: 'America/Vancouver', dateFormat: 'yyyy-MM-dd', signingOrder: input.sequential ? 'SEQUENTIAL' : 'PARALLEL', distributionMethod: 'EMAIL' } }))
      form.set('files', new Blob([new Uint8Array(input.bytes)], { type: 'application/pdf' }), input.filename)
      return envelopeId(string(object(await json('/envelope/create', { method: 'POST', body: form })).id))
    },
    async get(id: string) { return snapshotOf(await json('/envelope/' + encodeURIComponent(envelopeId(id)))) },
    async recover(reference: string) {
      const found: string[] = []
      for (let page = 1; page <= 50; page++) {
        const v = object(await json(`/envelope?type=DOCUMENT&perPage=100&page=${page}`)), rows = array(v.data)
        for (const raw of rows) { const r = object(raw); if (r.externalId === reference) found.push(envelopeId(string(r.id))) }
        if (rows.length < 100 || (Number.isFinite(Number(v.totalPages)) && page >= Number(v.totalPages))) {
          if (found.length > 1) throw new DocumensoError(true, 'More than one Documenso request uses this reference. Review them in Documenso before continuing.')
          return found[0] ?? null
        }
      }
      throw new DocumensoError(true, 'The team has too many documents for automatic reconciliation. Review this request in Documenso.')
    },
    async pdf(path: string) {
      const response = await call(path)
      const limit = 25 * 1024 * 1024
      if (Number(response.headers.get('content-length')) > limit) throw new DocumensoError(false, 'The Documenso PDF exceeds the 25 MB archive limit.')
      if (!response.body) throw new DocumensoError(true, 'Documenso returned an empty PDF.')
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new DocumensoError(false, 'The Documenso PDF exceeds the 25 MB archive limit.') } parts.push(value) }
      const bytes = Buffer.concat(parts)
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new DocumensoError(true, 'Documenso returned a file that is not a PDF. The archive will be retried.')
      return bytes
    },
  }
}
