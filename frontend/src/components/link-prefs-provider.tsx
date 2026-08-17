import { createContext, useContext, useEffect, useState } from "react"

// Link appearance preferences (per browser, an accessibility aid):
//   • linkIcons — show a trailing chain glyph after every link.
//   • linkColor — an optional colour for links ("" = neutral / inherit). Helps
//     users who need links to stand out (e.g. colour-blindness).
// Source of truth for both is <html> (the `link-icons` class + the
// `--link-color` inline style), seeded before paint by the boot script in
// __root.tsx so there is no flash. This provider reads them back and lets the
// settings controls flip them (class/var + localStorage).
const ICONS_KEY = "danbyte-link-icons"
const COLOR_KEY = "danbyte-link-color"

const LinkPrefsContext = createContext<{
  linkIcons: boolean
  setLinkIcons: (on: boolean) => void
  linkColor: string
  setLinkColor: (color: string) => void
}>({
  linkIcons: false,
  setLinkIcons: () => null,
  linkColor: "",
  setLinkColor: () => null,
})

function readIcons(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.classList.contains("link-icons")
}

function readColor(): string {
  if (typeof document === "undefined") return ""
  return document.documentElement.style.getPropertyValue("--link-color").trim()
}

export function LinkPrefsProvider({ children }: { children: React.ReactNode }) {
  const [linkIcons, setLinkIcons] = useState<boolean>(readIcons)
  const [linkColor, setLinkColor] = useState<string>(readColor)

  useEffect(() => {
    const root = document.documentElement
    if (linkIcons) root.classList.add("link-icons")
    else root.classList.remove("link-icons")
    localStorage.setItem(ICONS_KEY, linkIcons ? "on" : "off")
  }, [linkIcons])

  useEffect(() => {
    const root = document.documentElement
    if (linkColor) {
      root.style.setProperty("--link-color", linkColor)
      localStorage.setItem(COLOR_KEY, linkColor)
    } else {
      root.style.removeProperty("--link-color")
      localStorage.removeItem(COLOR_KEY)
    }
  }, [linkColor])

  return (
    <LinkPrefsContext.Provider
      value={{ linkIcons, setLinkIcons, linkColor, setLinkColor }}
    >
      {children}
    </LinkPrefsContext.Provider>
  )
}

export const useLinkPrefs = () => useContext(LinkPrefsContext)
