// The viewer's dragged height, remembered per user and per kind of viewer
// in this browser. Storage can be missing or throw (private windows,
// blocked site data); the viewer then just uses its default height.

function key(user: string, what: string): string {
  return `danbyte.file-viewer.height.${user || "anon"}.${what}`
}

export function readHeight(user: string, what: string): number | null {
  try {
    const raw = localStorage.getItem(key(user, what))
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function writeHeight(user: string, what: string, px: number) {
  try {
    localStorage.setItem(key(user, what), String(Math.round(px)))
  } catch {
    /* not remembered */
  }
}

export function clearHeight(user: string, what: string) {
  try {
    localStorage.removeItem(key(user, what))
  } catch {
    /* nothing to clear */
  }
}
