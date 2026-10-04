// The modifier a shortcut label names: the Command key on Apple platforms,
// Ctrl everywhere else. Labels read "⌘S" on a Mac and "Ctrl+S" elsewhere, so
// the helper carries the joiner too - `${modKey()}S`.
//
// Call it where the label is drawn (a tooltip, a menu shortcut). Both render
// only once opened, in the browser, so the server's "Ctrl+" never has to
// hydrate against a Mac's "⌘".

type NavigatorLike = {
  platform?: string
  userAgent?: string
  userAgentData?: { platform?: string }
}

/** True on macOS, iPadOS and iOS, where shortcuts use the Command key. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const nav = navigator as NavigatorLike
  // userAgentData is the modern source (Chromium); platform is deprecated but
  // still the only one Safari and Firefox fill in; the UA string backs both.
  const platform =
    nav.userAgentData?.platform || nav.platform || nav.userAgent || ""
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** "⌘" on Apple platforms, "Ctrl+" elsewhere. */
export function modKey(): string {
  return isApplePlatform() ? "⌘" : "Ctrl+"
}
