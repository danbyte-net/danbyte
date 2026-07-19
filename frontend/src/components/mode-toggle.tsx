import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/components/theme-provider"

// Single-click theme toggle. Click → flips light/dark immediately.
// No dropdown, no "system" option — that was confusing.
export function ModeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      // The theme is read from the <html> class that the inline FOUC
      // script in __root.tsx sets pre-paint — SSR can't know the user's
      // saved theme, so aria-label always differs server-vs-client.
      // Suppressing the warning here is the React-recommended escape;
      // the client's value wins after hydration.
      suppressHydrationWarning
    >
      <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
    </Button>
  )
}
