import { InfoTip } from "@/components/ui/info-tip"

export interface SeriesItem {
  key: string
  label: string
  color: string
}

/**
 * A chart legend you can use: click a series to hide it, double-click to
 * see only it (double-click again to bring the rest back). Hidden series
 * stay in the legend, dimmed, so they can be brought back. Rendered
 * outside the chart so it never shifts the plot area.
 */
export function SeriesLegend({
  items,
  hidden,
  onChange,
  className,
}: {
  items: SeriesItem[]
  hidden: Set<string>
  onChange: (next: Set<string>) => void
  className?: string
}) {
  const toggle = (key: string) => {
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }
  const solo = (key: string) => {
    const others = items.filter((i) => i.key !== key).map((i) => i.key)
    const alreadySolo =
      !hidden.has(key) &&
      others.every((k) => hidden.has(k)) &&
      others.length > 0
    onChange(alreadySolo ? new Set() : new Set(others))
  }
  return (
    <ul
      className={
        "flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs " +
        (className ?? "")
      }
    >
      {items.map((s) => {
        const off = hidden.has(s.key)
        return (
          <li key={s.key}>
            <button
              type="button"
              onClick={() => toggle(s.key)}
              onDoubleClick={() => solo(s.key)}
              aria-pressed={!off}
              className={
                "inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-muted-foreground transition-opacity hover:text-foreground " +
                (off ? "line-through opacity-40" : "")
              }
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </button>
          </li>
        )
      })}
      <li>
        <InfoTip>Click to hide a series; double-click to see only it.</InfoTip>
      </li>
    </ul>
  )
}
