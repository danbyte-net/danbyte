import type { LifecycleInfo } from "@/lib/api"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import {
  LifecycleBadge,
  eolCountdown,
  lifecyclePct,
} from "@/components/cells/lifecycle-cell"
import { useDateFormat } from "@/lib/datetime"

// "Lifecycle" overview card — device type + platform detail pages. Shows the
// lifetime progress bar (release → EoL) plus every vendor date the user
// entered. Rendered even when empty, so the feature is discoverable.

export function LifecycleCard({
  item,
  title = "Lifecycle",
}: {
  item: LifecycleInfo
  title?: string
}) {
  const { formatDate } = useDateFormat()
  const fmtDate = (d: string | null): React.ReactNode =>
    d ? <span className="num">{formatDate(d)}</span> : dash
  const pct = lifecyclePct(item)
  const rows: KvRow[] = [
    {
      label: "Status",
      value: item.lifecycle_state ? (
        <LifecycleBadge state={item.lifecycle_state} />
      ) : (
        <span className="text-muted-foreground">No dates entered</span>
      ),
    },
    ...(pct !== null
      ? [
          {
            label: "Lifetime",
            value: (
              <div className="flex items-center gap-3">
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
                  <div
                    className={
                      "h-full " +
                      (pct >= 100
                        ? "bg-red-500"
                        : pct > 85
                          ? "bg-amber-500"
                          : "bg-primary")
                    }
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="num text-xs text-muted-foreground">
                  {pct}% · {eolCountdown(item)}
                </span>
              </div>
            ),
          } satisfies KvRow,
        ]
      : []),
    { label: "Released", value: fmtDate(item.release_date) },
    { label: "End of sale", value: fmtDate(item.end_of_sale) },
    {
      label: "End of security updates",
      value: fmtDate(item.end_of_security_updates),
    },
    { label: "End of support (EoL)", value: fmtDate(item.end_of_support) },
    ...(item.lifecycle_url
      ? [
          {
            label: "Vendor notice",
            value: (
              <a
                href={item.lifecycle_url}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {item.lifecycle_url}
              </a>
            ),
            copy: item.lifecycle_url,
          } satisfies KvRow,
        ]
      : []),
  ]
  return <KvCard title={title} rows={rows} />
}
