/**
 * The script policy the frontend server sends with every HTML page (#498).
 *
 * Each response gets a fresh nonce; TanStack Router writes it on every
 * script it renders (the theme boot script, hydration data, the entry
 * module) and in a `csp-nonce` meta tag that the client router and Vite's
 * preload helper read. `'strict-dynamic'` then trusts what those scripts
 * load, so the lazy route chunks need no list of their own.
 *
 * This policy only governs scripts. nginx keeps sending its own
 * Content-Security-Policy on every response, HTML included, with the host
 * lists (tiles, GitHub, vulnerability sources) and `style-src`; a browser
 * enforces both, so a script must pass each. `'self' 'unsafe-inline'` here
 * is the fallback for browsers that know neither nonces nor
 * `'strict-dynamic'`: a browser that does ignores both.
 */

export type CspMode = "enforce" | "report" | "off"

export const CSP_MODES: readonly CspMode[] = ["enforce", "report", "off"]

/** Production default when DANBYTE_CSP_MODE is unset. */
export const DEFAULT_CSP_MODE: CspMode = "report"

export const CSP_REPORT_URI = "/api/csp-report/"

/**
 * The mode from the DANBYTE_CSP_MODE value. Unset or empty gives the
 * default; anything it does not know enforces, so a typo never turns the
 * policy off.
 */
export function parseCspMode(
  raw: string | undefined | null,
  fallback: CspMode = DEFAULT_CSP_MODE
): { mode: CspMode; valid: boolean } {
  const value = (raw ?? "").trim().toLowerCase()
  if (!value) return { mode: fallback, valid: true }
  if ((CSP_MODES as readonly string[]).includes(value)) {
    return { mode: value as CspMode, valid: true }
  }
  return { mode: "enforce", valid: false }
}

/** 128 random bits from the platform CSPRNG, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const NONCE_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** The policy text for one response. */
export function cspPolicy(nonce: string): string {
  // A nonce goes into a header and an attribute; never let anything but
  // base64 through, whoever calls this.
  if (!NONCE_RE.test(nonce)) throw new Error("CSP nonce must be base64")
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'self' 'unsafe-inline'`,
    // Workers fall back to script-src, where 'strict-dynamic' drops 'self':
    // name them, as nginx does (MapLibre, the CAD, outline and diagram
    // workers are bundled files; MapLibre may wrap one in a blob).
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    `report-uri ${CSP_REPORT_URI}`,
  ].join("; ")
}

/** The header this mode sends the policy in, or null for none. */
export function cspHeaderName(mode: CspMode): string | null {
  if (mode === "enforce") return "Content-Security-Policy"
  if (mode === "report") return "Content-Security-Policy-Report-Only"
  return null
}

/**
 * The response with the policy for `nonce` added, when it is an HTML page.
 * Other responses (JSON errors, redirects without a body) go out as they
 * came. A page carrying a nonce must never be served to someone else from a
 * cache, so it is marked private and revalidated.
 */
export function withCspHeaders(
  response: Response,
  nonce: string,
  mode: CspMode
): Response {
  const header = cspHeaderName(mode)
  const type = response.headers.get("content-type") ?? ""
  if (!header || !type.toLowerCase().startsWith("text/html")) return response
  const headers = new Headers(response.headers)
  headers.set(header, cspPolicy(nonce))
  if (!/\bno-store\b/i.test(headers.get("cache-control") ?? "")) {
    headers.set("Cache-Control", "private, no-cache")
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
