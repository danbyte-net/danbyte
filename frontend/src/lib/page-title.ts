import { isValidElement, useEffect, type ReactNode } from "react"

/**
 * What the browser tab says. The deployment name (or "Danbyte") is the
 * suffix; pages prepend what they're showing, so a row of open tabs reads
 * "Devices", "aarhus-fw1", "Change log" instead of the same word ten times.
 *
 * The root sets the bare deployment name and every shell calls this with its
 * own title; passing `null` (while a page is still loading) leaves the
 * current title alone rather than flashing a placeholder.
 */
let suffix = "Danbyte"

/** Called once by the root when the deployment name resolves. */
export function setTitleSuffix(name: string) {
  suffix = name.trim() || "Danbyte"
}

export function pageTitle(title?: string | null): string {
  const t = (title ?? "").trim()
  return t ? `${t} · ${suffix}` : suffix
}

/** Set the tab title for as long as this page is mounted. */
export function usePageTitle(title?: string | null) {
  useEffect(() => {
    if (typeof document === "undefined") return
    if (title === null || title === undefined) return
    document.title = pageTitle(title)
  }, [title])
}

/** Readable text inside a rendered title ("<span>eno2</span>" → "eno2"), so
 * a shell can name the tab from the node it already draws. */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join(" ")
  if (isValidElement(node))
    return nodeText((node.props as { children?: ReactNode }).children)
  return ""
}
