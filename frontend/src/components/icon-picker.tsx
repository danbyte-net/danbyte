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

export interface IconPickerProps {
  /** Kebab-case Lucide icon name, or "" for none. */
  value: string
  onChange: (next: string) => void
  className?: string
  allowEmpty?: boolean
}

/**
 * Searchable Lucide icon picker — type "cam", see the camera icons, click to
 * set. Same popover shape as ColorPicker so palette forms read as one family.
 */
export function IconPicker({
  value,
  onChange,
  className,
  allowEmpty = true,
}: IconPickerProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return ICON_NAMES
    return ICON_NAMES.filter((n) => n.includes(needle))
  }, [q])

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          placeholder="Search icons… (server, door, wind, cctv)"
          className="h-8 text-xs"
          autoFocus
        />
        <div className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto">
          {matches.slice(0, SHOWN).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                onChange(name)
                setOpen(false)
              }}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted",
                value === name && "bg-muted ring-1 ring-foreground/40"
              )}
              title={name}
              aria-label={name}
            >
              <DynamicIcon name={name} className="h-4 w-4" />
            </button>
          ))}
        </div>
        {matches.length === 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            No icons match “{q}”.
          </p>
        )}
        {matches.length > SHOWN && (
          <p className="text-[10px] text-muted-foreground">
            {matches.length - SHOWN} more — keep typing to narrow down.
          </p>
        )}
        {allowEmpty && value && (
          <button
            type="button"
            onClick={() => {
              onChange("")
              setOpen(false)
            }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
