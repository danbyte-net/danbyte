import { useMemo, useState } from "react"
import { Check, ChevronsUpDown, X } from "lucide-react"

import { type SiteOption } from "@/lib/api"
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

export interface SiteMultiSelectProps {
  options: SiteOption[]
  value: string[]
  onChange: (next: string[]) => void
  className?: string
  placeholder?: string
}

export function SiteMultiSelect({
  options,
  value,
  onChange,
  className,
  placeholder = "Add sites…",
}: SiteMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const valueSet = useMemo(() => new Set(value), [value])
  const selected = options.filter((o) => valueSet.has(o.id))

  function toggle(id: string) {
    const next = valueSet.has(id)
      ? value.filter((v) => v !== id)
      : [...value, id]
    onChange(next)
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {selected.map((s) => (
        <span
          key={s.id}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
        >
          {s.name}
          <button
            type="button"
            onClick={() => toggle(s.id)}
            className="-mr-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
            aria-label={`Remove ${s.name}`}
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
            <CommandInput placeholder="Search sites…" className="h-8 text-xs" />
            <CommandList>
              <CommandEmpty>No sites.</CommandEmpty>
              <CommandGroup>
                {options.map((s) => {
                  const isSel = valueSet.has(s.id)
                  return (
                    <CommandItem
                      key={s.id}
                      value={s.name}
                      onSelect={() => toggle(s.id)}
                      className="gap-2"
                    >
                      <Check
                        className={cn(
                          "h-3.5 w-3.5",
                          isSel ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="truncate text-xs">{s.name}</span>
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
