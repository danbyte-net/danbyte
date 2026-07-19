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

export interface ComboboxOption {
  value: string
  label: string
  /** Optional sub-category heading — options sharing a group render under it
   * (optgroup-style), in first-appearance order. Ungrouped options come first. */
  group?: string
  /** Not selectable (still listed, dimmed) — e.g. an occupied rack unit. */
  disabled?: boolean
  /** Muted right-aligned annotation — e.g. the device occupying a unit. */
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
// type-to-filter — used for the device pickers.
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
          <span className="truncate">
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
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
                    // Include the raw value so typing a slug (e.g. "sfpp",
                    // "smf-os2") matches, not just the pretty label.
                    value={`${o.label} ${o.value}`}
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
                    <span className="truncate">{o.label}</span>
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
