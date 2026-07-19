import { useEffect, useRef, useState } from "react"
import { Check, Pipette, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// Tailwind v3 palette laid out as rows-by-hue, columns-by-shade.
// Each row is one hue (red → … → fuchsia), columns go light→dark across
// 400 / 500 / 600 / 700 / 800 so the eye groups by color first and
// brightness second. Neutrals on the bottom row.
const PALETTE: string[] = [
  // red       orange     amber      yellow     lime
  "#f87171",
  "#ef4444",
  "#dc2626",
  "#b91c1c",
  "#7f1d1d",
  "#fb923c",
  "#f97316",
  "#ea580c",
  "#c2410c",
  "#7c2d12",
  "#fbbf24",
  "#f59e0b",
  "#d97706",
  "#b45309",
  "#78350f",
  "#facc15",
  "#eab308",
  "#ca8a04",
  "#a16207",
  "#713f12",
  "#a3e635",
  "#84cc16",
  "#65a30d",
  "#4d7c0f",
  "#365314",
  // green     emerald    teal       cyan       sky
  "#4ade80",
  "#22c55e",
  "#16a34a",
  "#15803d",
  "#14532d",
  "#34d399",
  "#10b981",
  "#059669",
  "#047857",
  "#064e3b",
  "#2dd4bf",
  "#14b8a6",
  "#0d9488",
  "#0f766e",
  "#134e4a",
  "#22d3ee",
  "#06b6d4",
  "#0891b2",
  "#0e7490",
  "#164e63",
  "#38bdf8",
  "#0ea5e9",
  "#0284c7",
  "#0369a1",
  "#0c4a6e",
  // blue      indigo     violet     purple     fuchsia
  "#60a5fa",
  "#3b82f6",
  "#2563eb",
  "#1d4ed8",
  "#1e3a8a",
  "#818cf8",
  "#6366f1",
  "#4f46e5",
  "#4338ca",
  "#312e81",
  "#a78bfa",
  "#8b5cf6",
  "#7c3aed",
  "#6d28d9",
  "#4c1d95",
  "#c084fc",
  "#a855f7",
  "#9333ea",
  "#7e22ce",
  "#581c87",
  "#e879f9",
  "#d946ef",
  "#c026d3",
  "#a21caf",
  "#701a75",
  // pink      rose       neutrals (zinc 400→900)
  "#f472b6",
  "#ec4899",
  "#db2777",
  "#be185d",
  "#831843",
  "#fb7185",
  "#f43f5e",
  "#e11d48",
  "#be123c",
  "#881337",
  "#a1a1aa",
  "#71717a",
  "#52525b",
  "#3f3f46",
  "#18181b",
]

export interface ColorPickerProps {
  value: string
  onChange: (next: string) => void
  className?: string
  /** Allow clearing the color back to "". Default true. */
  allowEmpty?: boolean
}

function isValidHex(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v)
}

function normalizeHex(v: string): string {
  let s = v.trim().toLowerCase()
  if (!s) return ""
  if (!s.startsWith("#")) s = "#" + s
  // Expand #abc → #aabbcc
  if (/^#[0-9a-f]{3}$/.test(s)) {
    s =
      "#" +
      s
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
  }
  return s
}

export function ColorPicker({
  value,
  onChange,
  className,
  allowEmpty = true,
}: ColorPickerProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(value)
  const nativeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setText(value)
  }, [value])

  function commit(v: string) {
    const norm = normalizeHex(v)
    if (norm === "" || isValidHex(norm)) {
      onChange(norm)
      setText(norm)
    }
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border transition-colors hover:border-foreground/40"
            style={value ? { backgroundColor: value } : undefined}
            aria-label="Open color picker"
          >
            {!value && <Pipette className="h-4 w-4 text-muted-foreground" />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto gap-3 p-3">
          {/* Preset grid — rows are hues, columns are shades (light→dark). */}
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}
          >
            {PALETTE.map((hex) => {
              const selected = value.toLowerCase() === hex.toLowerCase()
              return (
                <button
                  key={hex}
                  type="button"
                  onClick={() => {
                    onChange(hex)
                    setText(hex)
                    setOpen(false)
                  }}
                  className={cn(
                    "relative h-6 w-6 rounded-md ring-offset-popover transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                    selected && "ring-2 ring-foreground/60 ring-offset-2"
                  )}
                  style={{ backgroundColor: hex }}
                  aria-label={hex}
                  title={hex}
                >
                  {selected && (
                    <Check className="absolute inset-0 m-auto h-3 w-3 text-white mix-blend-difference" />
                  )}
                </button>
              )
            })}
          </div>

          <div className="my-2 h-px w-full bg-border" />

          {/* Native color input — covers anything not in the palette */}
          <div className="flex items-center gap-2">
            <input
              ref={nativeRef}
              type="color"
              value={value || "#000000"}
              onChange={(e) => commit(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-border"
              aria-label="Custom color"
            />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => commit(text)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commit(text)
                  setOpen(false)
                }
              }}
              placeholder="#10b981"
              className="h-7 font-mono text-xs"
            />
          </div>

          {allowEmpty && value && (
            <button
              type="button"
              onClick={() => {
                onChange("")
                setText("")
                setOpen(false)
              }}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </PopoverContent>
      </Popover>

      {/* Inline hex input for direct typing without opening the popover. */}
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit(text)
          }
        }}
        placeholder="#10b981"
        className="h-9 font-mono"
      />
    </div>
  )
}
