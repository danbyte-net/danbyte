// Wired to the project's own ThemeProvider (light ⇌ dark only) instead
// of next-themes so toasts match the rest of the app from first paint.
import { useTheme } from "@/components/theme-provider"
import { Spinner } from "@/components/ui/spinner"
import { toast, Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
} from "lucide-react"

// ── Global "Copy" action on every error toast ───────────────────────────────
// Error toasts almost always carry an API/exception message worth copying
// (validation detail, stack-ish strings). Rather than thread a copy button
// through ~70 `toast.error(...)` call sites, augment `toast.error` once here:
// when the message is a string, attach a Copy action that grabs it to the
// clipboard. Patched a single time, idempotently, at module load.
type ToastErr = typeof toast.error
const _toast = toast as unknown as { error: ToastErr; __copyPatched?: boolean }
if (!_toast.__copyPatched) {
  const orig = toast.error.bind(toast)
  _toast.error = ((message, data) => {
    const text = typeof message === "string" ? message : undefined
    const action =
      data?.action ??
      (text
        ? {
            label: "Copy",
            // preventDefault keeps the toast open so the user sees "Copied".
            onClick: (e: { preventDefault: () => void }) => {
              e.preventDefault()
              navigator.clipboard?.writeText(text).then(
                () => toast.success("Copied to clipboard", { duration: 1500 }),
                () => {}
              )
            },
          }
        : undefined)
    return orig(message, { duration: 8000, ...data, action })
  }) as ToastErr
  _toast.__copyPatched = true
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Spinner className="size-4" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
