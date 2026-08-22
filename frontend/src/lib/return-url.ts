// The `?ret=` convention: a form opened from another page carries that
// page's URL and returns there on save/cancel, instead of dumping the user
// on the form's list page (issue #76). Entry links pass `ret: hereUrl()`;
// form routes validate it with `safeReturnPath` and push it back.

/** Current pathname+search for a `?ret=` round-trip (undefined during SSR). */
export function hereUrl(): string | undefined {
  if (typeof window === "undefined") return undefined
  return window.location.pathname + window.location.search
}

/** Only same-app absolute paths ride `?ret=` - never protocol-relative or
 * external URLs (open-redirect guard). */
export function safeReturnPath(s: unknown): string | undefined {
  return typeof s === "string" && s.startsWith("/") && !s.startsWith("//")
    ? s
    : undefined
}
