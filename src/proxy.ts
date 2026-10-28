import { NextResponse, type NextRequest } from 'next/server'
import { isExcludedModulePath, isPublicModulePath } from '@/lib/installed-routes'

/**
 * The cheap gate in front of everything.
 *
 * `proxy.ts`, not `middleware.ts`: the middleware convention is DEPRECATED in
 * Next.js 16 and renamed (node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/middleware.md). It defaults to the Node.js runtime here,
 * and setting `runtime` in a proxy file throws.
 *
 * IT DOES NOT TOUCH THE DATABASE, deliberately. Next's own guidance is that
 * proxy runs on every request including prefetched routes, so a query here is
 * a query on every hover. All it does is ask whether a session cookie is
 * PRESENT and send anonymous traffic to the sign-in page.
 *
 * SO IT IS NOT THE SECURITY BOUNDARY. A forged cookie gets past this and stops
 * at `gate.ts`, which reads the session and answers who is asking. This exists
 * to redirect a person who is not signed in, not to keep anybody out. Every
 * page calls `requireUser()` and every route calls `guardRoute()` regardless,
 * and `N14` requires it of each one — a gate that lives only here would be a
 * gate that a route handler can forget to be behind.
 */

const COOKIE = 'erp_session'

/**
 * The path, handed to the application in a request header.
 *
 * A server component cannot ask "what URL am I", and the gate needs to know in
 * order to answer "may you be here" — otherwise every page would have to name
 * its own module, which is 68 places to forget. Proxy already sees the path,
 * and the version's own docs describe passing information on exactly this way
 * (03-file-conventions/proxy.md, "Setting Headers").
 *
 * It is set by the proxy on every request, so a caller cannot supply their own:
 * the header they send is REPLACED, not merged. It carries the query string as
 * well as the path, because one route can hand out several modules' data
 * depending on what is asked for.
 *
 * The gate REFUSES when it is missing rather than admitting: a boundary that
 * cannot answer "may you be here" must not answer "yes".
 */
export const PATH_HEADER = 'x-erp-path'

/** Reachable without signing in: the sign-in page itself, and first-run setup. */
const OPEN = ['/login', '/first-run']

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  // WebDAV needs PROPFIND, which this Next version's route handlers do not
  // accept. Handle this one path here before the browser-cookie redirect; its
  // own boundary checks a company-scoped app password on every request.
  if (pathname.startsWith('/dav/')) {
    const { handleWebDav } = await import('@/lib/webdav')
    return handleWebDav(request)
  }
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const canonical = request.nextUrl.clone()
    canonical.pathname = pathname.slice(0, -1)
    return NextResponse.redirect(canonical, 308)
  }
  const signedIn = request.cookies.has(COOKIE)

  // The path this request is for, replacing anything the caller sent under
  // that name.
  const headers = new Headers(request.headers)
  // The QUERY TOO. `/export?what=journal` and `/export?what=gst-hst` are one
  // route carrying two different seats' worth of data, so the seat cannot be
  // decided from the pathname alone (critic, 2026-09-03).
  //
  // DECODED, the way the router reads it. `nextUrl.pathname` keeps percent
  // escapes and the router does not: `/ledger/%35a3f…/backup/file` matched no
  // ledger in the gate, was judged a path outside every company and admitted,
  // and Next still handed the page the decoded id — any signed-in person who
  // knew a ledger's id could open every module of it (security review,
  // 2026-10-20). A path that does not decode is not one the router can route.
  let routed: string
  try { routed = pathname.split('/').map(decodeURIComponent).join('/') }
  catch { return new NextResponse('That address could not be read.', { status: 400 }) }
  if (isExcludedModulePath(routed)) return new NextResponse('Not found.', { status: 404 })
  headers.set(PATH_HEADER, routed + request.nextUrl.search)
  const carryOn = () => NextResponse.next({ request: { headers } })

  // Exact MCP surface authenticates a scoped bearer token through gate.ts.
  if (pathname === '/mcp') return carryOn()

  // Installed callbacks authenticate independently in their route handler.
  if (isPublicModulePath(routed)) return carryOn()
  // Exact capability/provider surfaces only. Every handler still uses gate.ts.
  if(/^\/pay\/[0-9a-f-]{36}(?:\/(?:session|status|checkout|pdf))?$/i.test(pathname)){
    const response=carryOn()
    response.headers.set('Cache-Control','private, no-store, max-age=0')
    response.headers.set('Referrer-Policy','no-referrer')
    response.headers.set('X-Robots-Tag','noindex, nofollow')
    response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
    return response
  }
  if(/^\/integrations\/(?:stripe|postmark)\/[0-9a-f-]{36}$/i.test(pathname))return carryOn()

  if (OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // Login verifies the actual session. Cookie presence alone would send an
    // expired/foreign cookie to '/', whose real gate sends it straight back.
    return carryOn()
  }

  if (!signedIn) {
    const to = new URL('/login', request.url)
    // Come back to where they were going once they are in.
    if (pathname !== '/') to.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(to)
  }

  return carryOn()
}

export const config = {
  /**
   * Everything except Next's own assets and the tab's icon. Written as an
   * exclusion rather than a list of protected paths: a list would have to be
   * kept in step with the routes, and the failure of forgetting to add one is
   * silent and is exactly what this is for.
   *
   * THE ICON HAS TO BE OUT HERE. It is requested by the tab, not by a person,
   * and the first page anybody sees is the login screen — where there is no
   * session, so a gated icon is redirected and the tab sits blank. `favicon.ico`
   * was excluded and the old `icon.svg` was not, so renaming the mark on 2026-09-12
   * quietly took it off the login screen; the check that said the icon was
   * there was reading the file, and the file was never the question
   * (found by restarting the server, 2026-09-12).
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|figtree-icon.png|banyan-icon.png).*)'],
}
