import { useMemo, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ComboboxOption {
  value: string
  label: string
  /** Optional sub-category heading - options sharing a group render under it
   * (optgroup-style), in first-appearance order. Ungrouped options come first. */
  group?: string
  /** Catalog color: the option renders as its ColorBadge pill (roles,
   * statuses) instead of plain text - a status/role looks the same here as
   * everywhere else. Never rendered as a dot. */
  color?: string | null
  /** Not selectable (still listed, dimmed) - e.g. an occupied rack unit. */
  disabled?: boolean
  /** Muted right-aligned annotation - e.g. the device occupying a unit. */
  hint?: string
}

export interface ComboboxProps {
  value: string | null
  onChange: (v: string | null) => void
  options: ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** When set, offers a clear-to-null row at the top with this label. */
  noneLabel?: string
  disabled?: boolean
  className?: string
}

// Searchable single-select (shadcn Combobox pattern: Button + Popover +
// Command). Drop-in for a Select when the option list is long enough to want
// type-to-filter - used for the device pickers.
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  noneLabel,
  disabled,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)

  // Partition into sub-categories, preserving first-appearance order.
  // Ungrouped options (no `group`) collect under a heading-less section.
  const sections = useMemo(() => {
    const out: { heading?: string; items: ComboboxOption[] }[] = []
    const byGroup = new Map<string, ComboboxOption[]>()
    for (const o of options) {
      const key = o.group ?? ""
      let items = byGroup.get(key)
      if (!items) {
        items = []
        byGroup.set(key, items)
        out.push({ heading: o.group, items })
      }
      items.push(o)
    }
    return out
  }, [options])

  function pick(v: string | null) {
    onChange(v)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-9 w-full justify-between font-normal",
            !selected && "text-muted-foreground",
            className
          )}
        >
          {/* min-w-0: a flex child's min-width defaults to its content, so
              truncate alone never engages and a long label spills out. */}
          {selected?.color ? (
            <ColorBadge name={selected.label} color={selected.color} />
          ) : selected ? (
            // The field is narrow, so a long value still truncates here -
            // hovering (or focusing) shows it in full.
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate">{selected.label}</span>
              </TooltipTrigger>
              <TooltipContent>{selected.label}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="min-w-0 truncate">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // min-w = trigger width, but the list may grow wider: an option's
        // full name always has to be readable (a truncated "Cisco Nexus
        // 931..." is useless when three types share that prefix).
        className="w-auto max-w-[min(38rem,calc(100vw-2rem))] min-w-(--radix-popover-trigger-width) p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {noneLabel && (
              <CommandGroup>
                <CommandItem
                  value={noneLabel}
                  onSelect={() => pick(null)}
                  className="gap-2"
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5",
                      value === null ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="text-muted-foreground">{noneLabel}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {sections.map((section, i) => (
              <CommandGroup
                key={section.heading ?? `__ungrouped-${i}`}
                heading={section.heading}
              >
                {section.items.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    // What the search actually matches. The label always; the
                    // raw value only when it is a meaningful slug ("sfpp") -
                    // never a UUID, which fuzzy/substring-matched short
                    // searches and made "SW07" list its siblings (#49).
                    keywords={
                      UUID_RE.test(o.value)
                        ? [o.label, o.hint ?? ""]
                        : [o.label, o.value, o.hint ?? ""]
                    }
                    disabled={o.disabled}
                    onSelect={() => pick(o.value)}
                    className="gap-2"
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5",
                        value === o.value ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {o.color ? (
                      <ColorBadge name={o.label} color={o.color} />
                    ) : (
                      <span className="whitespace-normal">{o.label}</span>
                    )}
                    {o.hint && (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {o.hint}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
