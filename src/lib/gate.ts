import 'server-only'
import { cache } from 'react'
import { serviceSecretMatches } from './service-auth'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { actorOf, userForToken, type UserRecord } from './users'
import { refuseFor, refuseForEntity, refuseForLedger } from './access'
import { PATH_HEADER } from '@/proxy'
import type {PortalScope} from './customer-portal'
import {exchangeInvitation,portalScope,publicPaymentOrigin} from './customer-portal'
import {IntegrationError,integrationId} from './integration-access'
import {integrationFailure} from './integration-http'
import { assertDeploymentModules } from './module-compatibility'

/**
 * THE ONE GATE. Every page and every route handler goes through here.
 *
 * Next.js 16's own guidance (node_modules/next/dist/docs/01-app/02-guides/
 * authentication.md) is a Data Access Layer: `proxy.ts` does a cheap
 * cookie-presence check because it runs on every request including prefetches
 * and must not touch the database, and the REAL check lives in one function
 * that reads the session and answers who is asking. `proxy.ts` is a
 * convenience; this is the security boundary. If the two ever disagree, this
 * one is right.
 *
 * WHY IT IS ONE FUNCTION AND NOT A CONVENTION. RISKS §15b lists fifteen route
 * handlers that hand data out — an employee's paycheque, the transparency
 * register's birth dates, every receipt ever attached. A system that gates its
 * pages and not its routes is not gated, and "remember to check" is not a
 * mechanism. `N14` reads every page.tsx and route.ts in the tree and requires
 * each to reach this file, the same way `N1` requires every module to have a
 * seat in the rail.
 *
 * `cache` is React's, per render pass: a page and its four components asking
 * who is asking is one query, not five.
 */

export class GateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GateError'
  }
}

export const SESSION_COOKIE = 'erp_session'

/** Who is asking, or null. Never redirects — for the login page's own use. */
export const currentUser = cache(async (): Promise<UserRecord | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  await assertDeploymentModules()
  return token ? userForToken(token) : null
})

/**
 * Who is asking. Sends them to sign in if the answer is nobody.
 *
 * Every page calls this. `redirect` throws, so there is no path where a page
 * body runs without a user — which is the property that matters and the reason
 * this returns the user rather than a boolean.
 */
export async function requireUser(allowMfaSetup = false): Promise<UserRecord> {
  const user = await currentUser()
  if (!user) redirect('/login')

  // AND may they be here. 0054 gave people a set of companies and a set of
  // modules; this is where that is enforced, once, in the function every
  // entrypoint already calls — rather than 68 places each naming their own
  // module, which is 68 places to forget one.
  //
  // The rail also hides seats somebody has not been given, but that is a
  // courtesy. A hidden seat whose URL still answers is the defect RISKS §15b
  // was written about, and if the two ever disagree this one is right.
  //
  // FAIL CLOSED. The first version wrapped this in `if (path)` and admitted a
  // request whose header was missing — indistinguishable, from inside, from a
  // request that was allowed (critic, 2026-09-03). The proxy sets it on
  // everything except Next's own static assets, so a missing header means the
  // request did not come through the proxy, and that is the case a boundary
  // exists for.
  const path = (await headers()).get(PATH_HEADER)
  if (path === null) redirect('/no-access?why=NO_PATH')
  // Only the two trusted enrollment callers may admit an unbound admin.
  // A Server Action can be POSTed to a different page; its URL is not scope.
  if (process.env.AUTH_ADMIN_MFA_REQUIRED === 'true' && user.is_owner && !user.mfa_enabled && !user.strong_auth
      && !(allowMfaSetup && /^\/settings\/security(?:[/?]|$)/.test(path))) redirect('/settings/security')
  const refusal = await refuseFor(user, path)
  // A PAGE, not a thrown error: an uncaught throw renders a 500, and Next
  // strips the message from it in production — so the person would meet a
  // blank failure instead of a sentence, which is the opposite of this
  // project's rule. `/no-access` is never itself refused (refuseFor only
  // judges ledger paths), so this cannot loop.
  if (refusal) redirect(`/no-access?why=${refusal.code}`)
  return user
}

/**
 * The person, and the assurance that they may act on THIS ledger — the one in
 * the form body, not the one in the URL.
 *
 * Every server action reads the ledger it writes to out of the form. The URL it
 * POSTs to is the page the form was on, so `requireUser` above judged that page
 * and nothing judged the id. Standing on a company they hold, one POST wrote
 * into a company they do not (critic, 2026-09-03).
 *
 * `module` is the seat the action belongs to — the seat of the page its form
 * lives on. Without it, invoking a payroll action from a page in a seat they DO
 * hold would still run: the ids would match and nothing would ask which part of
 * the books this was. `N18` re-derives every one of these from the tree.
 */
export async function requireLedger(
  ledgerId: string, module: string | string[],
): Promise<UserRecord> {
  const user = await requireUser()
  const refusal = await refuseForLedger(user, ledgerId, module)
  if (refusal) redirect(`/no-access?why=${refusal.code}`)
  return user
}

/** The same, for an action that names a company rather than a ledger. */
export async function requireEntity(entityId: string): Promise<UserRecord> {
  const user = await requireUser()
  const refusal = await refuseForEntity(user, entityId)
  if (refusal) redirect(`/no-access?why=${refusal.code}`)
  return user
}

/**
 * An owner, or they are sent away. Managing people and taking a whole-database
 * backup are the two things a bookkeeper has no business doing.
 */
export async function requireOwner(): Promise<UserRecord> {
  const user = await requireUser()
  // Not a query parameter nobody reads: the first version redirected with
  // `?denied=owner` and nothing anywhere looked at it, so a bookkeeper who
  // opened /users landed on the desk with no explanation (critic). This
  // refuses by name, which is what the rest of the system does.
  // A PAGE, for the same reason `requireUser` redirects rather than throws: a
  // bookkeeper who opened /users met a bare 500 with no sentence in it, because
  // Next strips a thrown message in production. Found by opening the page as a
  // bookkeeper, not by any check — the throw was written the day before the
  // redirect was, and only one of the two was revisited.
  if (!user.is_owner) redirect('/no-access?why=NEEDS_OWNER')
  return user
}

export function unauthorized(): Response {
  return new Response('Sign in to see this.', {
    status: 401,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * What every route handler does first. Returns the user, or the response to
 * send instead — so a handler reads:
 *
 *   const who = await guardRoute()
 *   if (who instanceof Response) return who
 */
export function guardRoute(options: { serviceSecretHash: string; serviceSecretHeader: string }): Promise<Response | null>
export function guardRoute(options: { mcp: Request }): Promise<import('./mcp-credentials').McpPrincipal | Response>
export function guardRoute(options:{portal:{id:string;token:string;write?:boolean}}):Promise<PortalScope|Response>
export function guardRoute(options:{portalExchange:{id:string;token:string}}):Promise<{session:string}|Response>
export function guardRoute(options:{delivery:{provider:'stripe'|'postmark';id:string;body:Buffer;credential:string|null}}):Promise<{id:string;duplicate:boolean}|Response>
export function guardRoute(options?: { owner?: boolean }): Promise<UserRecord | Response>
export async function guardRoute(options: { owner?: boolean; serviceSecretHash?: string;serviceSecretHeader?:string;mcp?:Request;portal?:{id:string;token:string;write?:boolean};portalExchange?:{id:string;token:string};delivery?:{provider:'stripe'|'postmark';id:string;body:Buffer;credential:string|null} } = {}): Promise<UserRecord | PortalScope | {session:string} | {id:string;duplicate:boolean} | import('./mcp-credentials').McpPrincipal | Response | null> {
  await headers()
  await assertDeploymentModules()
  if (options.mcp) return (await import('./mcp-http')).guardMcp(options.mcp)
  try{
    if(options.portal||options.portalExchange){
      if(options.portal?.write||options.portalExchange){
        if((await headers()).get('origin')!==publicPaymentOrigin())throw new IntegrationError('ORIGIN','Invalid invoice request.',403)
      }
      if(options.portalExchange){const result=await exchangeInvitation(options.portalExchange.id,options.portalExchange.token);return {session:result.session}}
      return portalScope(options.portal!.token,options.portal!.id)
    }
    if(options.delivery){
      publicPaymentOrigin()
      if((await headers()).get('x-forwarded-proto')!=='https')throw new IntegrationError('TLS','External delivery requires the configured HTTPS ingress.',403)
      const {provider,id,body,credential}=options.delivery
      if(provider==='stripe')return (await import('./online-payments')).receiveStripe(id,body,credential)
      return (await import('./inbound-mail')).receivePostmark(id,credential,body)
    }
  }catch(error){return integrationFailure(error)}
  // Service notifications carry no browser cookie. This separate credential
  // authenticates the one webhook route; it never grants a user session.
  if (options.serviceSecretHash !== undefined) {
    const secret = options.serviceSecretHeader ? (await headers()).get(options.serviceSecretHeader) : null
    if (!serviceSecretMatches(secret, options.serviceSecretHash)) {
      return new Response('Unauthorized.', { status: 401 })
    }
    return null
  }
  const user = await currentUser()
  if (!user) return unauthorized()

  // The same question a page asks, answered with a status instead of a throw:
  // these are the fifteen doors that hand data out, and a PDF of a company
  // somebody may not open is the same leak as its page.
  // Fail closed here too, with a status rather than a redirect.
  const path = (await headers()).get(PATH_HEADER)
  if (path === null) {
    return new Response('This request did not come through the front door.', {
      status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (process.env.AUTH_ADMIN_MFA_REQUIRED === 'true' && user.is_owner && !user.mfa_enabled && !user.strong_auth) return new Response('Set up strong authentication in Account security.',{status:403})
  const refusal = await refuseFor(user, path)
  if (refusal) {
    return new Response(refusal.message, {
      status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (options.owner && !user.is_owner) {
    return new Response('That needs an owner account.', {
      status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  return user
}

/** Public confirmation contains no company/customer data; GET never exchanges its fragment secret. */
export async function requirePortalConfirmation(id:string){
  return integrationId(id)
}

/** Re-exported so a page has one import: it is defined in `users.ts`. */
export { actorOf }

/** The actor for the current request, in one call. */
export async function currentActor(): Promise<string> {
  return actorOf(await requireUser())
}
