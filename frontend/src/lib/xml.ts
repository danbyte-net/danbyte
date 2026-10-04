// Escaping for markup built as strings. The table exports (XLSX, HTML) and the
// diagram writers assemble their documents by hand, dependency-free, so every
// user-supplied value goes through one of these on its way in.

/** A text node or attribute value in XML. Also drops the C0 control
 * characters XML 1.0 forbids - Excel and draw.io reject a file carrying one -
 * keeping tab, newline and return. */
export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  )
}

/** A text node or attribute value (single- or double-quoted) in HTML. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
