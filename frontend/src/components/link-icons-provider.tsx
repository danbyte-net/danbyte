import { createContext, useContext, useEffect, useState } from "react"

// "Show link icon on linked objects" preference. Off by default: links are
// neutral (underline on hover) and only reveal a trailing chain glyph when this
// is on. Mirrors ThemeProvider — the source of truth is the `link-icons` class
// on <html>, seeded before paint by the boot script in __root.tsx, so there is
// no flash. This provider just reads it back and lets the settings toggle flip
// it (class + localStorage).
const STORAGE_KEY = "danbyte-link-icons"

const LinkIconsContext = createContext<{
  linkIcons: boolean
  setLinkIcons: (on: boolean) => void
}>({ linkIcons: false, setLinkIcons: () => null })

function readInitial(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.classList.contains("link-icons")
}

export function LinkIconsProvider({ children }: { children: React.ReactNode }) {
  const [linkIcons, setLinkIcons] = useState<boolean>(readInitial)

  useEffect(() => {
    const root = document.documentElement
    if (linkIcons) root.classList.add("link-icons")
    else root.classList.remove("link-icons")
    localStorage.setItem(STORAGE_KEY, linkIcons ? "on" : "off")
  }, [linkIcons])

  return (
    <LinkIconsContext.Provider value={{ linkIcons, setLinkIcons }}>
      {children}
    </LinkIconsContext.Provider>
  )
}

export const useLinkIcons = () => useContext(LinkIconsContext)
