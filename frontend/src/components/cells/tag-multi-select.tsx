import { useMemo, useState } from "react"
import { Check, ChevronsUpDown, X } from "lucide-react"

import { type TagOption } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
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

// Tag multi-select powered by shadcn's Combobox pattern (Command + Popover).
// Renders the selected tags inline as a row of removable colored chips,
// with the picker trigger at the end. Plain controlled state — pass
// `value` (tag IDs) and `onChange`.

export interface TagMultiSelectProps {
  options: TagOption[]
  value: number[]
  onChange: (next: number[]) => void
  className?: string
  placeholder?: string
}

export function TagMultiSelect({
  options,
  value,
  onChange,
  className,
  placeholder = "Add tags…",
}: TagMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const valueSet = useMemo(() => new Set(value), [value])
  const selected = options.filter((o) => valueSet.has(o.id))

  function toggle(id: number) {
    const next = valueSet.has(id)
      ? value.filter((v) => v !== id)
      : [...value, id]
    onChange(next)
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {selected.map((t) => (
        <ColorBadge
          key={t.id}
          name={t.name}
          color={t.color || undefined}
          suffix={
            <button
              type="button"
              onClick={() => toggle(t.id)}
              className="-mr-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
              aria-label={`Remove ${t.name}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          }
        />
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
            <CommandInput placeholder="Search tags…" className="h-8 text-xs" />
            <CommandList>
              <CommandEmpty>No tags.</CommandEmpty>
              <CommandGroup>
                {options.map((t) => {
                  const isSel = valueSet.has(t.id)
                  return (
                    <CommandItem
                      key={t.id}
                      value={t.name}
                      onSelect={() => toggle(t.id)}
                      className="gap-2"
                    >
                      <Check
                        className={cn(
                          "h-3.5 w-3.5",
                          isSel ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <ColorBadge name={t.name} color={t.color || undefined} />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
