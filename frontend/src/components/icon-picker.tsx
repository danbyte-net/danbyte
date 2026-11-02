import { useMemo, useState } from "react"
import { X } from "lucide-react"

import { DynamicIcon, ICON_NAMES } from "@/components/dynamic-icon"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const SHOWN = 96

/** The network gear group at the top of the picker: an icon and what it
 * stands for, so "firewall" or "ups" finds it. Code, not data - nothing is
 * seeded. */
export const NETWORK_ICONS: readonly { name: string; label: string }[] = [
  { name: "router", label: "Router" },
  { name: "network", label: "Switch" },
  { name: "ethernet-port", label: "Switch" },
  { name: "shield", label: "Firewall" },
  { name: "brick-wall", label: "Firewall" },
  { name: "server", label: "Server" },
  { name: "wifi", label: "Access point" },
  { name: "radio-tower", label: "Access point" },
  { name: "cctv", label: "Camera" },
  { name: "printer", label: "Printer" },
  { name: "phone", label: "Phone" },
  { name: "battery-charging", label: "UPS" },
  { name: "plug", label: "Power" },
  { name: "plug-zap", label: "PDU" },
  { name: "hard-drive", label: "Storage" },
  { name: "database", label: "Storage" },
  { name: "cable", label: "Patch panel" },
  { name: "split", label: "Load balancer" },
  { name: "lock-keyhole", label: "VPN" },
  { name: "cloud", label: "Cloud" },
  { name: "monitor", label: "Monitor" },
]

const CURATED = new Set(NETWORK_ICONS.map((i) => i.name))

/** What the picker shows for a search: the network group's matches (by
 * name or by what they stand for), then every other icon whose name
 * matches - none twice. */
export function matchIcons(query: string): {
  network: readonly { name: string; label: string }[]
  rest: readonly string[]
} {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return {
      network: NETWORK_ICONS,
      rest: ICON_NAMES.filter((n) => !CURATED.has(n)),
    }
  }
  return {
    network: NETWORK_ICONS.filter(
      (i) => i.name.includes(needle) || i.label.toLowerCase().includes(needle)
    ),
    rest: ICON_NAMES.filter((n) => !CURATED.has(n) && n.includes(needle)),
  }
}

export interface IconPickerProps {
  /** Kebab-case Lucide icon name, or "" for none. */
  value: string
  onChange: (next: string) => void
  className?: string
  allowEmpty?: boolean
}

/**
 * Searchable Lucide icon picker - type "cam", see the camera icons, click to
 * set. The network group (routers, switches, firewalls…) comes first. Same
 * popover shape as ColorPicker so palette forms read as one family.
 */
export function IconPicker({
  value,
  onChange,
  className,
  allowEmpty = true,
}: IconPickerProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  // The icon under the pointer, named in the footer - no native title.
  const [hover, setHover] = useState<string | null>(null)

  const { network, rest } = useMemo(() => matchIcons(q), [q])
  const label = (name: string) =>
    NETWORK_ICONS.find((i) => i.name === name)?.label

  const cell = (name: string, aria: string) => (
    <button
      key={name}
      type="button"
      onClick={() => {
        onChange(name)
        setOpen(false)
      }}
      onPointerEnter={() => setHover(name)}
      onPointerLeave={() => setHover(null)}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted",
        value === name && "bg-muted ring-1 ring-foreground/40"
      )}
      aria-label={aria}
    >
      <DynamicIcon name={name} className="h-4 w-4" />
    </button>
  )
  const heading = (text: string) => (
    <p className="text-[10px] font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase">
      {text}
    </p>
  )
  const shown = rest.slice(0, SHOWN)
  const shownHover = hover ?? value

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setHover(null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm transition-colors hover:border-foreground/40",
            className
          )}
          aria-label="Open icon picker"
        >
          {value ? (
            <>
              <DynamicIcon name={value} className="h-4 w-4" />
              <span className="font-mono text-xs">{value}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Pick an icon…</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2 p-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search icons…"
          className="h-8 text-xs"
          autoFocus
        />
        <div className="grid max-h-64 gap-2 overflow-y-auto">
          {network.length > 0 && (
            <div className="grid gap-1" data-group="network">
              {heading("Network")}
              <div className="grid grid-cols-8 gap-1">
                {network.map((i) => cell(i.name, `${i.label}: ${i.name}`))}
              </div>
            </div>
          )}
          {shown.length > 0 && (
            <div className="grid gap-1" data-group="all">
              {network.length > 0 && heading("All icons")}
              <div className="grid grid-cols-8 gap-1">
                {shown.map((name) => cell(name, name))}
              </div>
            </div>
          )}
        </div>
        {network.length + rest.length === 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            No icons match “{q}”.
          </p>
        )}
        <div className="flex min-h-4 items-center gap-2 text-[11px] text-muted-foreground">
          {shownHover && (
            <span className="truncate font-mono">
              {shownHover}
              {label(shownHover) && (
                <span className="font-sans"> · {label(shownHover)}</span>
              )}
            </span>
          )}
          {rest.length > SHOWN && !shownHover && (
            <span>{rest.length - SHOWN} more - keep typing</span>
          )}
          {allowEmpty && value && (
            <button
              type="button"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
              className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
