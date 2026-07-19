import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

// Shared filter-rail building blocks. Every list page uses these:
//
//   <FilterRail>
//     <FacetGroup label="Status" options={...} selected={...} onToggle={...} />
//     ...children
//   </FilterRail>
//
// Adding a new list page = drop FilterRail + N FacetGroups in the aside.

export interface FacetOption {
  value: string
  label: string
  count: number
  /** Optional swatch color. When set, the label renders as a colored chip. */
  color?: string
  textColor?: string
}

// Toggles one value in/out of a Set without mutating the original.
export function toggleInSet<T>(
  current: Set<T>,
  value: T,
  setter: (s: Set<T>) => void
) {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  setter(next)
}

export function FilterRail({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <aside
      className={cn(
        "hidden h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-background p-4 lg:flex",
        className
      )}
    >
      {children}
    </aside>
  )
}

export interface FacetGroupProps {
  label: string
  options: FacetOption[]
  selected: Set<string>
  onToggle: (v: string) => void
}

export function FacetGroup({
  label,
  options,
  selected,
  onToggle,
}: FacetGroupProps) {
  if (options.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </h3>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => selected.forEach((v) => onToggle(v))}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            clear
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {options.map((opt) => (
          <li key={opt.value}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
              <Checkbox
                checked={selected.has(opt.value)}
                onCheckedChange={() => onToggle(opt.value)}
                aria-label={opt.label}
              />
              {opt.color ? (
                <span
                  className="inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: opt.color,
                    color: opt.textColor || "#fff",
                  }}
                >
                  {opt.label}
                </span>
              ) : (
                <span className="flex-1">{opt.label}</span>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {opt.count}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
