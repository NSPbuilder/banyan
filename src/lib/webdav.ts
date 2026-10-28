import 'server-only'
import { createHash } from 'node:crypto'
import { readBlobBytes, webdavFilesOf, type WebDavFile } from './attachments'
import { authenticateWebDav, webdavRights } from './webdav-credentials'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALLOW = 'OPTIONS, PROPFIND, GET, HEAD'
const XML = 'application/xml; charset=utf-8'
const SAFE_MIME = /^(application\/pdf|image\/(png|jpe?g|webp|gif))$/

type Node = { segments: string[]; file?: WebDavFile }
const keyOf = (segments: string[]) => segments.join('\0')
const escapeXml = (value: string) => value.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[c]!)

function nodesFor(files: WebDavFile[]) {
  const nodes = new Map<string, Node>([['', { segments: [] }]])
  for (const file of files) {
    for (let depth = 1; depth < file.segments.length; depth++) {
      const segments = file.segments.slice(0, depth)
      const key = keyOf(segments)
      if (!nodes.has(key)) nodes.set(key, { segments })
    }
    nodes.set(keyOf(file.segments), { segments: file.segments, file })
  }
  return nodes
}

function childrenOf(nodes: Map<string, Node>, parent: Node) {
  const depth = parent.segments.length + 1
  return [...nodes.values()].filter((node) =>
    node.segments.length === depth
    && node.segments.slice(0, depth - 1).every((s, i) => s === parent.segments[i]))
    .sort((a, b) => a.segments.at(-1)!.localeCompare(b.segments.at(-1)!))
}

function hrefFor(entityId: string, node: Node) {
  const tail = node.segments.map(encodeURIComponent).join('/')
  return `/dav/${entityId}/${tail}${node.file ? '' : tail ? '/' : ''}`
}

function propResponse(entityId: string, node: Node) {
  const name = node.segments.at(-1) ?? ''
  const file = node.file
  const modified = file ? new Date(file.modifiedAt) : new Date(0)
  const props = [
    `<D:displayname>${escapeXml(name)}</D:displayname>`,
    file ? '<D:resourcetype/>' : '<D:resourcetype><D:collection/></D:resourcetype>',
    `<D:getlastmodified>${modified.toUTCString()}</D:getlastmodified>`,
    `<D:creationdate>${modified.toISOString()}</D:creationdate>`,
    '<D:supportedlock/>', '<D:lockdiscovery/>',
  ]
  if (file) props.push(
    `<D:getcontentlength>${file.byteSize}</D:getcontentlength>`,
    `<D:getcontenttype>${escapeXml(SAFE_MIME.test(file.mime) ? file.mime : 'application/octet-stream')}</D:getcontenttype>`,
    `<D:getetag>${escapeXml(`"${file.sha256}"`)}</D:getetag>`,
  )
  return '<D:response>'
    + `<D:href>${escapeXml(hrefFor(entityId, node))}</D:href>`
    + '<D:propstat><D:prop>' + props.join('') + '</D:prop>'
    + '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
}

function unauthorized() {
  return new Response('WebDAV credentials are required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="FigTree WebDAV", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  })
}

function plain(message: string, status: number) {
  return new Response(message, {
    status, headers: { 'Cache-Control': 'no-store', Allow: ALLOW },
  })
}

function relativeParts(pathname: string, entityId: string): string[] | null {
  const prefix = `/dav/${entityId}`
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null
  const raw = pathname.slice(prefix.length).split('/').filter(Boolean)
  try {
    const parts = raw.map(decodeURIComponent)
    if (parts.some((part) => !part || part === '.' || part === '..'
      || part.includes('/') || part.includes('\\') || part.includes('\0'))) return null
    return parts
  } catch { return null }
}

function directoryPage(entityId: string, node: Node, nodes: Map<string, Node>) {
  const links = childrenOf(nodes, node).map((child) =>
    `<li><a href="${escapeXml(hrefFor(entityId, child))}">${escapeXml(child.segments.at(-1)!)}${child.file ? '' : '/'}</a></li>`)
  const html = '<!doctype html><html lang="en"><meta charset="utf-8">'
    + '<title>Banyan attachments</title><h1>Banyan attachments</h1>'
    + `<ul>${links.join('')}</ul></html>`
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } })
}

function rangeOf(header: string | null, size: number): [number, number] | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return 'invalid'
  const [, first, last] = match
  const start = first ? Number(first) : Math.max(0, size - Number(last))
  let end = first && last ? Number(last) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || start >= size) return 'invalid'
  end = Math.min(end, size - 1)
  return [start, end]
}

/** Runs only for /dav in proxy.ts. Next route handlers do not accept PROPFIND. */
export async function handleWebDav(request: Request): Promise<Response> {
  await (await import('./module-compatibility')).assertDeploymentModules()
  const pathname = new URL(request.url).pathname
  const match = /^\/dav\/([^/]+)(?:\/|$)/.exec(pathname)
  const entityId = match?.[1] ?? ''
  if (!UUID.test(entityId)) return plain('No such WebDAV folder.', 404)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      Allow: ALLOW, DAV: '1', 'MS-Author-Via': 'DAV', 'Cache-Control': 'no-store',
    } })
  }
  if (!['PROPFIND', 'GET', 'HEAD'].includes(request.method)) {
    return plain('This WebDAV folder is read-only.', 405)
  }
  const parts = relativeParts(pathname, entityId)
  if (!parts) return plain('No such WebDAV folder.', 404)
  const user = await authenticateWebDav(request.headers.get('authorization'), entityId)
  if (!user) return unauthorized()
  const rights = await webdavRights(user, entityId)
  const nodes = nodesFor(await webdavFilesOf(entityId, rights))
  const node = nodes.get(keyOf(parts))
  if (!node || (!!node.file && pathname.endsWith('/'))) {
    return plain('No such file or folder.', 404)
  }

  if (request.method === 'PROPFIND') {
    const depth = request.headers.get('depth') ?? '1'
    if (depth !== '0' && depth !== '1') {
      return plain('Only Depth: 0 and Depth: 1 are supported.', 403)
    }
    const responses = [node, ...(depth === '1' && !node.file ? childrenOf(nodes, node) : [])]
    const xml = '<?xml version="1.0" encoding="utf-8"?>'
      + '<D:multistatus xmlns:D="DAV:">'
      + responses.map((item) => propResponse(entityId, item)).join('')
      + '</D:multistatus>'
    return new Response(xml, {
      status: 207,
      headers: { 'Content-Type': XML, DAV: '1', 'Cache-Control': 'no-store' },
    })
  }

  if (!node.file) {
    return request.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
      : directoryPage(entityId, node, nodes)
  }
  const file = node.file
  const bytes = await readBlobBytes(file.company, file.sha256)
  if (!bytes) return plain('The attachment file is missing from the store.', 404)
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    return plain('The attachment file failed its integrity check.', 409)
  }
  const range = rangeOf(request.headers.get('range'), bytes.length)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: {
      'Content-Range': `bytes */${bytes.length}`, 'Cache-Control': 'no-store',
    } })
  }
  const body = range ? bytes.subarray(range[0], range[1] + 1) : bytes
  const headers: Record<string, string> = {
    'Content-Type': SAFE_MIME.test(file.mime) ? file.mime : 'application/octet-stream',
    'Content-Length': String(body.length),
    'Accept-Ranges': 'bytes',
    'ETag': `"${file.sha256}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (range) headers['Content-Range'] = `bytes ${range[0]}-${range[1]}/${bytes.length}`
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
    status: range ? 206 : 200, headers,
  })
}
