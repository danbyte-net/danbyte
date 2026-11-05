// Where the docs site lives. Every deployment (native nginx, Docker on any
// port) serves it same-origin under /docs/; only the Vite dev server sends it
// to the Zensical server on :8001 (#472). Pass a page path
// (Zensical uses directory URLs, e.g. "features/iac-runner/") plus an optional
// "#anchor" to deep-link a section.
/** Zensical serves directory URLs, so "features/iac-runner" (no trailing
 * slash) makes the docs server redirect - and that redirect comes back without
 * the /docs prefix, landing on the SPA as a 404 (#123). Normalising here means
 * a call site that forgets the slash still produces a working link. */
function withDirSlash(path: string): string {
  const [page, hash = ""] = path.split("#")
  if (!page || page.endsWith("/") || /\.[a-z0-9]+$/i.test(page)) return path
  return `${page}/${hash ? `#${hash}` : ""}`
}

export function docsUrl(path = ""): string {
  const clean = withDirSlash(path.replace(/^\/+/, ""))
  if (!import.meta.env.DEV || typeof window === "undefined") return `/docs/${clean}`
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:8001/${clean}`
}
