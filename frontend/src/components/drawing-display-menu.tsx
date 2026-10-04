import { ChevronDown, SlidersHorizontal } from "lucide-react"

import { BarButton } from "@/components/map-toolbar"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Display ▾ on a drawing's toolbar - a rack's elevation and a cabinet's
// plate: the drawing's ticks (its text, the live ports) and, on a rack,
// which gear it shows - gathered in one menu so the toolbar stays one row
// beside the modes, the zoom and Export.

export interface DisplayTick {
  label: string
  checked: boolean
  onChange: (on: boolean) => void
}

export interface DisplayChoice<TValue extends string> {
  label: string
  value: TValue
  options: readonly { value: TValue; label: string }[]
  onChange: (value: TValue) => void
}

export function DrawingDisplayMenu<TValue extends string = string>({
  ticks,
  choice,
  className,
}: {
  ticks: DisplayTick[]
  /** One of a few, under its label - the rack's Show. */
  choice?: DisplayChoice<TValue>
  className?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The word and the chevron go when the toolbar is narrow, as
            Export's do; screen readers keep the word. */}
        <BarButton className={className}>
          <SlidersHorizontal />
          <span className="sr-only @[34rem]:not-sr-only">Display</span>
          <ChevronDown className="hidden @[34rem]:-mr-1 @[34rem]:block" />
        </BarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {ticks.map((t) => (
          <DropdownMenuCheckboxItem
            key={t.label}
            checked={t.checked}
            onCheckedChange={(on) => t.onChange(on)}
            // A tick leaves the menu open for the next one.
            onSelect={(e) => e.preventDefault()}
          >
            {t.label}
          </DropdownMenuCheckboxItem>
        ))}
        {choice && (
          <>
            {ticks.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{choice.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={choice.value}
              onValueChange={(v) => choice.onChange(v as TValue)}
            >
              {choice.options.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value}>
                  {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
