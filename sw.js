/* Answers sardify/file/<id> and sardify/zip/<folderId> with bytes from the page. See src/services/streaming.ts. */
importScripts('range.js', 'vendor/client-zip-worker.js') // client-zip 2.5.1, MIT

const PREFIX = new URL('sardify/', self.registration.scope).pathname
const CHUNK_BYTES = 512 * 1024
const ANSWER_TIMEOUT_MILLIS = 120000

const MEDIA_TYPES = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
// The page's regular message is what keeps a long download's worker awake
self.addEventListener('message', () => undefined)

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return
  event.respondWith(respond(event, url).catch((error) => plain(502, error.message)))
})

function plain(status, text, headers) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain', ...headers } })
}

/** A download frame or media request may have no client of its own, so any open page can answer. */
async function pageFor(event) {
  const own = event.clientId && (await self.clients.get(event.clientId))
  if (own) return own
  const pages = await self.clients.matchAll({ type: 'window' })
  if (!pages.length) throw new Error('Sardify is not open in this browser')
  return pages[0]
}

function ask(page, request) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => reject(new Error('Sardify did not answer')), ANSWER_TIMEOUT_MILLIS)
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer)
      channel.port1.close()
      if (data.error) reject(new Error(data.error))
      else resolve(data)
    }
    page.postMessage(request, [channel.port2])
  })
}

/** Asks for one piece at a time, only when the reader wants more, so a seek stops the fetching. */
function bytesBetween(page, id, start, end) {
  let position = start
  return new ReadableStream(
    {
      async pull(controller) {
        if (position > end) {
          controller.close()
          return
        }
        const length = Math.min(end - position + 1, CHUNK_BYTES)
        const { bytes } = await ask(page, { kind: 'read', id, start: position, length })
        controller.enqueue(bytes)
        position += bytes.length
        if (position > end) controller.close()
      },
    },
    { highWaterMark: 0 },
  )
}

function attachment(name) {
  const safe = name.replace(/["\\\r\n]/g, '_')
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

async function respond(event, url) {
  const [kind, id] = url.pathname.slice(PREFIX.length).split('/')
  const page = await pageFor(event)
  if (kind === 'file') return respondFile(event, url, page, Number(id))
  if (kind === 'zip') return respondZip(page, Number(id))
  return plain(404, 'Not found')
}

async function respondFile(event, url, page, id) {
  const { info } = await ask(page, { kind: 'file', id })
  if (!info) return plain(404, 'No such file')
  const range = parseRange(event.request.headers.get('Range'), info.size)
  if (!range) return plain(416, 'Range not satisfiable', { 'Content-Range': `bytes */${info.size}` })
  const extension = info.name.slice(info.name.lastIndexOf('.') + 1).toLowerCase()
  const headers = {
    'Content-Type': MEDIA_TYPES[extension] || 'application/octet-stream',
    'Content-Length': String(range.end - range.start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (url.searchParams.has('download')) headers['Content-Disposition'] = attachment(info.name)
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`
  const body = info.size ? bytesBetween(page, id, range.start, range.end) : null
  return new Response(body, { status: range.partial ? 206 : 200, headers })
}

async function respondZip(page, folderId) {
  const { info } = await ask(page, { kind: 'zip', id: folderId })
  if (!info || !info.files.length) return plain(404, 'Nothing to download here')
  function* entries() {
    for (const file of info.files) {
      yield {
        name: file.path,
        size: file.size,
        lastModified: new Date(),
        // Made only when the zip reaches this file
        input: file.size ? bytesBetween(page, file.id, 0, file.size - 1) : new Uint8Array(),
      }
    }
  }
  const metadata = info.files.map((file) => ({ name: file.path, size: file.size }))
  const zip = downloadZip(entries(), { metadata })
  return new Response(zip.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': zip.headers.get('Content-Length'),
      'Content-Disposition': attachment(`${info.name}.zip`),
      'Cache-Control': 'no-store',
    },
  })
}
