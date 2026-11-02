/**
 * Works out which bytes a Range header asks for. Returns { start, end }, or null if it cannot be
 * met, the same answers as the backend's stream. Separate from sw.js so tests can load it.
 */
globalThis.parseRange = function (header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return { start: 0, end: size - 1, partial: false }
  if (!match[1]) {
    const last = Number(match[2])
    if (!last || !size) return null
    return { start: Math.max(0, size - last), end: size - 1, partial: true }
  }
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (start >= size || end < start) return null
  return { start, end, partial: true }
}
