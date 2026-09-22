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
  /** A short mono detail beside the name - a file path, say - shown on the
   * chip and in the list so two same-named rows stay tellable apart. */
  hint?: string
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
  footer,
}: {
  options: IdOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  /** A line under the list - a count, usually. A long list scrolls, and
   * without a visible end an operator who does not know what to search for
   * assumes the first screen is all there is. */
  footer?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Cleared after each pick. cmdk keeps the query, so choosing one match left
  // the list filtered to it and the next choice looked impossible without
  // manually emptying the box first.
  const [query, setQuery] = useState("")
  const valueSet = useMemo(() => new Set(value), [value])
  const selected = options.filter((o) => valueSet.has(o.id))

  const toggle = (id: string) => {
    onChange(valueSet.has(id) ? value.filter((v) => v !== id) : [...value, id])
    setQuery("")
  }

  // What the current search actually shows - so "select all" means the twelve
  // in front of you when you have searched, not the two hundred behind them.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options
  }, [options, query])
  const allShown = shown.length > 0 && shown.every((o) => valueSet.has(o.id))

  const toggleAll = () => {
    const ids = shown.map((o) => o.id)
    onChange(
      allShown
        ? value.filter((v) => !ids.includes(v))
        : [...value, ...ids.filter((id) => !valueSet.has(id))]
    )
    setQuery("")
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {selected.map((o) => (
        <span
          key={o.id}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
        >
          {o.name}
          {o.hint && (
            <span className="font-mono text-muted-foreground">{o.hint}</span>
          )}
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
          {/* The popover stays open across picks: choosing several from one
              catalog is the normal case, and reopening per item turned a
              five-template rule into five searches. */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={searchPlaceholder}
              value={query}
              onValueChange={setQuery}
              className="h-8 text-xs"
            />
            {shown.length > 1 && (
              <div className="flex items-center justify-between border-b border-border px-2 py-1">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {allShown ? "Clear" : "Select"} all {shown.length}
                  {query.trim() ? " shown" : ""}
                </button>
                {value.length > 0 && (
                  <span className="num text-[11px] text-muted-foreground">
                    {value.length} chosen
                  </span>
                )}
              </div>
            )}
            {/* Taller than the default, and with the scrollbar showing: the
                whole point of a long catalog is that there is more below. */}
            <CommandList className="max-h-80 [scrollbar-width:thin]!">
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {shown.map((o) => {
                  const on = valueSet.has(o.id)
                  return (
                    <CommandItem
                      key={o.id}
                      value={o.name}
                      onSelect={() => toggle(o.id)}
                      className="gap-2"
                    >
                      {/* A box, not a tick: an empty row has to look like
                          something you can turn on, which a hidden checkmark
                          does not. */}
                      <span
                        aria-hidden
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/40"
                        )}
                      >
                        {on && <Check className="h-2.5 w-2.5" />}
                      </span>
                      <span className="truncate text-xs">{o.name}</span>
                      {o.hint && (
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                          {o.hint}
                        </span>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
            {footer && (
              <div className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
                {footer}
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
