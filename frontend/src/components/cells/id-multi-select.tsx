import { useMemo, useState } from "react"
import { Check, ChevronsUpDown, X } from "lucide-react"

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

export interface IdOption {
  id: string
  name: string
}

/** A generic id/name multi-select: chosen items render as removable chips, and
 * a searchable popover toggles membership. Mirrors the RT/tag multi-selects but
 * takes plain `{id,name}` options, so it fits any small catalog list. */
export function IdMultiSelect({
  options,
  value,
  onChange,
  placeholder = "Add…",
  searchPlaceholder = "Search…",
  emptyText = "Nothing to pick.",
  className,
}: {
  options: IdOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const valueSet = useMemo(() => new Set(value), [value])
  const selected = options.filter((o) => valueSet.has(o.id))

  const toggle = (id: string) =>
    onChange(valueSet.has(id) ? value.filter((v) => v !== id) : [...value, id])

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {selected.map((o) => (
        <span
          key={o.id}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
        >
          {o.name}
          <button
            type="button"
            onClick={() => toggle(o.id)}
            className="-mr-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
            aria-label={`Remove ${o.name}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
          >
            <ChevronsUpDown className="mr-1 h-3 w-3" />
            {placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput
              placeholder={searchPlaceholder}
              className="h-8 text-xs"
            />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem
                    key={o.id}
                    value={o.name}
                    onSelect={() => toggle(o.id)}
                    className="gap-2"
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5",
                        valueSet.has(o.id) ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate text-xs">{o.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
