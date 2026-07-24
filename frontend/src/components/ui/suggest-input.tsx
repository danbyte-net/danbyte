import * as React from "react"
import { useMemo, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface SuggestInputProps extends Omit<
  React.ComponentProps<"input">,
  "value" | "onChange"
> {
  value: string
  onChange: (v: string) => void
  /** Common values offered in the dropdown. Any other text is still valid. */
  suggestions: string[]
}

/**
 * A text field that offers the common values for it in a dropdown, while
 * staying free text — the operator can always type something the list has
 * never heard of.
 *
 * This exists because `<datalist>` doesn't: the browser draws that popup
 * itself, ignoring the theme, the type scale and the dark palette. Here the
 * list is a normal popover styled like every other one in the app.
 */
export function SuggestInput({
  value,
  onChange,
  suggestions,
  className,
  disabled,
  onKeyDown,
  onClick,
  ...props
}: SuggestInputProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Typing narrows the list. Once the value IS one of the options, offer them
  // all again — the operator is changing their mind, not still searching.
  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q || suggestions.some((s) => s.toLowerCase() === q)) return suggestions
    return suggestions.filter((s) => s.toLowerCase().includes(q))
  }, [value, suggestions])

  const show = open && !disabled && matches.length > 0

  function pick(v: string) {
    onChange(v)
    setOpen(false)
    setActive(-1)
    inputRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      if (!show) {
        setOpen(true)
        setActive(0)
        return
      }
      setActive((i) => (i + 1) % matches.length)
    } else if (e.key === "ArrowUp") {
      if (!show) return
      e.preventDefault()
      setActive((i) => (i <= 0 ? matches.length - 1 : i - 1))
    } else if (e.key === "Enter" && show && active >= 0) {
      // Only swallow Enter when a row is highlighted, so the field still
      // submits its form when the operator is just typing.
      e.preventDefault()
      pick(matches[active])
    } else if (e.key === "Escape" && show) {
      e.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  return (
    <Popover
      open={show}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setActive(-1)
      }}
    >
      <PopoverAnchor asChild>
        {/* Fills its slot in both a block Field and a flex row, so the
            wrapper never collapses the input it holds. */}
        <div ref={wrapRef} className="relative w-full min-w-0 flex-1">
          <Input
            ref={inputRef}
            value={value}
            disabled={disabled}
            role="combobox"
            aria-expanded={show}
            aria-autocomplete="list"
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
              setActive(-1)
            }}
            // Click, type or ArrowDown opens it — not plain focus, or tabbing
            // through a form would pop a list open at every such field.
            onClick={(e) => {
              onClick?.(e)
              setOpen(true)
            }}
            onKeyDown={handleKeyDown}
            className={cn("pr-8", className)}
            {...props}
          />
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label="Show common values"
            onClick={() => {
              setOpen((o) => !o)
              inputRef.current?.focus()
            }}
            className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground disabled:opacity-50"
          >
            <ChevronDown className="h-4 w-4 opacity-50" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        // This is a text box first and a list second: focus stays in the
        // field so typing never breaks, and clicking the field or its chevron
        // isn't treated as dismissing the list.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (wrapRef.current?.contains(e.target as Node)) e.preventDefault()
        }}
        // gap-0 matters: PopoverContent is a flex column with gap-4, which
        // would space these rows like paragraphs.
        className="max-h-56 w-(--radix-popover-trigger-width) gap-0 overflow-y-auto p-1"
      >
        {matches.map((s, i) => (
          <button
            key={s}
            type="button"
            // Keep the caret in the field — mousedown would blur it first.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(s)}
            className={cn(
              "relative flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none",
              i === active && "bg-muted text-foreground"
            )}
          >
            {s}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
