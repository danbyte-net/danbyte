// Where the docs site lives. Behind the nginx proxy everything is same-origin
// under /docs/; in dev the Zensical server runs on :8001. Pass a page path
// (Zensical uses directory URLs, e.g. "features/iac-runner/") plus an optional
// "#anchor" to deep-link a section.
export function docsUrl(path = ""): string {
  const clean = path.replace(/^\/+/, "")
  if (typeof window === "undefined") return `/docs/${clean}`
  const { protocol, hostname, port } = window.location
  const base =
    port === "" || port === "80" || port === "443"
      ? "/docs/"
      : `${protocol}//${hostname}:8001/`
  return `${base}${clean}`
}
