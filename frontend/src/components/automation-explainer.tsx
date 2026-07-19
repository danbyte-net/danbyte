import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  Database,
  Server,
  Plug,
  Wand2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { docsUrl } from "@/lib/docs"
import { cn } from "@/lib/utils"

const DISMISS_KEY = "danbyte-automation-explainer-dismissed"

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

// Plain-words, three-box model of how config automation flows. Danbyte holds the
// intent, an automation target is the hand-off, your runner does the work. Used
// on the Automation targets + Deploy runs pages so a first-time user can tell
// what they're looking at and where each knob lives.
const FLOW = [
  {
    icon: Database,
    title: "Danbyte",
    sub: "stores the intended config",
  },
  {
    icon: Plug,
    title: "Automation target",
    sub: "the hand-off (AWX job / webhook)",
  },
  {
    icon: Server,
    title: "Your runner",
    sub: "touches the device — holds the credentials",
  },
] as const

// Where each piece is configured. Kept here (not just in docs) because the whole
// point of the explainer is that the nav locations aren't obvious.
const WHERE = [
  {
    do: "Define what the config should be",
    to: "/config-contexts" as const,
    where: "Customize → Config contexts / Export templates",
  },
  {
    do: "Connect your runner",
    to: "/automation-targets" as const,
    where: "Integrations → Automation targets",
  },
  {
    do: "Fire a deploy for one device",
    to: "/devices" as const,
    where: "a device → Config tab → Deploy",
  },
  {
    do: "See past dispatches (read-only)",
    to: "/deploy-runs" as const,
    where: "Integrations → Deploy runs",
  },
  {
    do: "Schedule the drift check",
    to: "/settings/admin" as const,
    where: "Admin → Settings",
  },
]

export interface AutomationExplainerProps {
  /** "panel" = full card with flow + where-to-click; "note" = one-line banner. */
  variant?: "panel" | "note"
  className?: string
}

export function AutomationExplainer({
  variant = "panel",
  className,
}: AutomationExplainerProps) {
  // Start shown on both server + first client render (avoids a hydration
  // mismatch), then hide in an effect if the user dismissed it before.
  const [dismissed, setDismissed] = useState(false)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (readDismissed()) setDismissed(true)
  }, [])

  if (dismissed) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      /* ignore */
    }
    setDismissed(true)
  }

  if (variant === "note") {
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground",
          className
        )}
      >
        <Plug className="mt-0.5 size-3.5 shrink-0" />
        <p className="min-w-0">
          This is a{" "}
          <span className="font-medium text-foreground">read-only</span> history
          of deploys Danbyte handed off to a runner. Configure the hand-off
          under{" "}
          <Link
            to="/automation-targets"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Automation targets
          </Link>
          ; Danbyte never touches the device itself.
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Dismiss"
        >
          <X className="size-3.5" />
          <span className="sr-only">Dismiss</span>
        </button>
      </div>
    )
  }

  return (
    <div className={cn("rounded-lg border border-border bg-card", className)}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90"
            )}
          />
          <span className="text-sm font-semibold">How automation works</span>
          <span className="truncate text-[11px] text-muted-foreground">
            Danbyte hands off — it never touches your devices
          </span>
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Dismiss"
        >
          <X className="size-3.5" />
          <span className="sr-only">Dismiss</span>
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          <p className="text-[13px] text-muted-foreground">
            Danbyte stores what each device's config{" "}
            <span className="text-foreground">should</span> be. To change a real
            device it hands the work to a runner{" "}
            <span className="text-foreground">you</span> control — your own
            Ansible/AWX, or any webhook. Three pieces:
          </p>

          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            {FLOW.map((step, i) => (
              <div key={step.title} className="flex items-center gap-2">
                <div className="flex flex-1 items-center gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <step.icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{step.title}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {step.sub}
                    </div>
                  </div>
                </div>
                {i < FLOW.length - 1 && (
                  <ArrowRight className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
                )}
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
              Where to set things up
            </div>
            <dl className="divide-y divide-border rounded-md border border-border text-[13px]">
              {WHERE.map((row) => (
                <div
                  key={row.do}
                  className="grid grid-cols-1 gap-x-4 px-3 py-1.5 sm:grid-cols-[1fr_auto]"
                >
                  <dt className="text-foreground">{row.do}</dt>
                  <dd>
                    <Link
                      to={row.to}
                      className="font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {row.where}
                    </Link>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" asChild>
              <Link to="/automation-targets/setup">
                <Wand2 className="size-4" />
                Guided setup
              </Link>
            </Button>
            <a
              href={docsUrl("features/iac-runner/")}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline"
            >
              <BookOpen className="size-3.5" />
              Read the config-drift guide
            </a>
            <span className="text-[11px] text-muted-foreground">
              or add a target manually — both end up in the same place.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
