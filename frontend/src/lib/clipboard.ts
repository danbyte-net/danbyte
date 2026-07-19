// Clipboard with a synchronous textarea fallback.
//
// `navigator.clipboard.writeText` only works in secure contexts (HTTPS
// or localhost). Danbyte is commonly accessed from a LAN IP over HTTP
// during dev/install — in that case `navigator.clipboard` is undefined
// and a copy call would throw. Fall back to the classic
// `document.execCommand("copy")` trick: stage a hidden textarea, select
// it, and let the browser do the copy. Works in every HTTP context.
export async function copyText(value: string): Promise<boolean> {
  if (typeof window === "undefined") return false
  // Preferred path — works in secure contexts.
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // fall through to legacy
    }
  }
  // Legacy path. `execCommand` is deprecated but every browser still
  // ships it because there is no other way to copy in non-secure HTTP.
  try {
    const ta = document.createElement("textarea")
    ta.value = value
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
