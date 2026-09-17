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

export interface MultiComboboxOption {
  value: string
  label: string
}

export interface MultiComboboxProps {
  options: MultiComboboxOption[]
  /** Everything ticked, handed over together when the footer button is
   *  pressed. The list clears and closes afterwards. */
  onAdd: (picked: MultiComboboxOption[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Verb on the footer button - "Add" by default. */
  verb?: string
  /** Most that can be ticked at once; further rows are left unticked. */
  max?: number
  disabled?: boolean
  className?: string
}

/** The Combobox's shape - one full-width trigger, a searchable list - for
 *  picking several rows at once: a box per row, select-all over what the
 *  search shows, and one button that hands the set over. The list stays open
 *  across ticks, so adding twelve devices is one search, not twelve. */
export function MultiCombobox({
  options,
  onAdd,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  verb = "Add",
  max,
  disabled,
  className,
}: MultiComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<Set<string>>(() => new Set())

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q
      ? options.filter((o) => o.label.toLowerCase().includes(q))
      : options
  }, [options, query])
  const allShown = shown.length > 0 && shown.every((o) => picked.has(o.value))
  const full = max !== undefined && picked.size >= max

  function toggle(value: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else if (max === undefined || next.size < max) next.add(value)
      return next
    })
  }
  function toggleAll() {
    setPicked((prev) => {
      const next = new Set(prev)
      if (allShown) for (const o of shown) next.delete(o.value)
      else
        for (const o of shown) {
          if (max !== undefined && next.size >= max) break
          next.add(o.value)
        }
      return next
    })
  }
  function close(next: boolean) {
    setOpen(next)
    if (!next) {
      setPicked(new Set())
      setQuery("")
    }
  }
  function add() {
    onAdd(options.filter((o) => picked.has(o.value)))
    close(false)
  }

  return (
    <Popover open={open} onOpenChange={close} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-9 w-full min-w-0 justify-between overflow-hidden font-normal",
            !picked.size && "text-muted-foreground",
            className
          )}
        >
          <span className="min-w-0 truncate">
            {picked.size ? `${picked.size} ticked` : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto max-w-[min(38rem,calc(100vw-2rem))] min-w-(--radix-popover-trigger-width) p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
            className="h-9"
          />
          {shown.length > 1 && (
            <div className="flex items-center justify-between border-b border-border px-3 py-1">
              <button
                type="button"
                onClick={toggleAll}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {allShown ? "Clear" : "Select"} all {shown.length}
                {query.trim() ? " shown" : ""}
              </button>
              {full && (
                <span className="num text-[11px] text-muted-foreground">
                  {max} at most
                </span>
              )}
            </div>
          )}
          <CommandList className="max-h-72">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {shown.map((o) => {
                const on = picked.has(o.value)
                return (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    onSelect={() => toggle(o.value)}
                    disabled={!on && full}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mr-2 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "opacity-60"
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 truncate">{o.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-end gap-2 border-t border-border p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!picked.size}
              onClick={add}
            >
              {verb}
              {picked.size ? ` ${picked.size}` : ""}
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
