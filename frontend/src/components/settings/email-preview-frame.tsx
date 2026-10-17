import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { apiText } from "@/lib/api"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

// The policy the preview endpoint sends with the page, repeated inside the
// document: a srcdoc frame takes no response headers, and a mail needs only
// inline styles and the data: logo.
const PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/** The rendered mail with the preview CSP as the first thing in its head. */
export function previewSrcDoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + meta + html.slice(at)
  }
  const doctype = /<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype.index + doctype[0].length
    return html.slice(0, at) + meta + html.slice(at)
  }
  return meta + html
}

/**
 * One email template rendered with sample data (#401).
 *
 * The HTML is fetched and handed to the frame as srcdoc rather than loaded
 * by URL: a reverse proxy that adds X-Frame-Options DENY or
 * frame-ancestors 'none' server-wide would otherwise block the frame.
 *
 * Sandbox: no scripts, forms, popups or navigation of the page. Same origin
 * is allowed so the page can read the document's height; with scripts off
 * nothing inside the frame can use that origin.
 */
export function EmailPreviewFrame({ template }: { template: string }) {
  const [height, setHeight] = useState(480)
  const q = useQuery({
    queryKey: ["email-template-html", template],
    queryFn: () =>
      apiText(
        `/api/deployment/email/templates/${encodeURIComponent(template)}/`
      ),
  })

  if (q.isError) return <QueryError error={q.error} />
  if (q.isPending)
    return (
      <div
        className="rounded-md border border-border bg-muted/30"
        style={{ height }}
      >
        <Loading />
      </div>
    )
  return (
    <iframe
      title="Email preview"
      srcDoc={previewSrcDoc(q.data)}
      sandbox="allow-same-origin"
      className="w-full rounded-md border border-border bg-muted/30"
      style={{ height }}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument
        if (doc) setHeight(Math.max(320, doc.documentElement.scrollHeight))
      }}
    />
  )
}
