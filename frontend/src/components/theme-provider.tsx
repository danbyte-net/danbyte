import { createContext, useContext, useEffect, useState } from "react"

// Two-state theme provider: light ⇌ dark. No "system" — the user
// explicitly didn't want that on the toggle. We still seed the initial
// value from prefers-color-scheme on first visit so users get a sane
// default before they've clicked anything.
//
// FOUC fix: an inline script in <head> (see __root.tsx) runs BEFORE
// React paints, reads localStorage, and writes `class="dark"` on <html>
// directly. By the time this provider mounts, the class is already
// correct — useState just reads it back.
type Theme = "dark" | "light"

const ThemeProviderContext = createContext<{
  theme: Theme
  toggleTheme: () => void
}>({ theme: "light", toggleTheme: () => null })

const STORAGE_KEY = "danbyte-theme"

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "light"
  // <html> class is the source of truth — set by the inline script in
  // __root.tsx before this component renders.
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme)

  useEffect(() => {
    const root = document.documentElement
    if (theme === "dark") root.classList.add("dark")
    else root.classList.remove("dark")
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  return (
    <ThemeProviderContext.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
      }}
    >
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeProviderContext)
