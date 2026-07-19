import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export interface CheckOption<V extends string | number> {
  value: V
  label: string
  hint?: string
}

/** A compact scrollable multi-select rendered as a checkbox list. Used by the
 * RBAC forms for groups / tenants / users / object-types. */
export function CheckList<V extends string | number>({
  options,
  value,
  onChange,
  className,
  empty = "Nothing to pick.",
}: {
  options: CheckOption<V>[]
  value: V[]
  onChange: (next: V[]) => void
  className?: string
  empty?: string
}) {
  const set = new Set(value)
  const toggle = (v: V) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange([...next])
  }
  if (options.length === 0)
    return <p className="text-xs text-muted-foreground">{empty}</p>
  return (
    <div
      className={cn(
        "max-h-56 overflow-auto rounded-md border border-border p-1",
        className
      )}
    >
      {options.map((o) => (
        <label
          key={String(o.value)}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-muted/50"
        >
          <Checkbox
            checked={set.has(o.value)}
            onCheckedChange={() => toggle(o.value)}
          />
          <span className="flex-1 truncate">{o.label}</span>
          {o.hint && (
            <span className="text-[11px] text-muted-foreground">{o.hint}</span>
          )}
        </label>
      ))}
    </div>
  )
}
