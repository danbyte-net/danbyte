import type { LifecycleInfo } from "@/lib/api"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { LifecycleBadge, LifecycleBar } from "@/components/cells/lifecycle-cell"
import type { LifecycleLike } from "@/components/cells/lifecycle-cell"
import { useDateFormat } from "@/lib/datetime"

// "Lifecycle" overview card - device type + platform detail pages. Shows the
// lifetime bar plus every vendor date the user entered. A platform's bar
// reads its effective dates (entered, else its end-of-life mapping). Rendered
// even when empty, so the feature is discoverable.

export function LifecycleCard({
  item,
  title = "Lifecycle",
}: {
  item: LifecycleInfo & LifecycleLike
  title?: string
}) {
  const { formatDate } = useDateFormat()
  const fmtDate = (d: string | null): React.ReactNode =>
    d ? <span className="num">{formatDate(d)}</span> : dash
  const rows: KvRow[] = [
    {
      label: "Status",
      value: item.lifecycle_state ? (
        <LifecycleBadge state={item.lifecycle_state} />
      ) : (
        <span className="text-muted-foreground">No dates entered</span>
      ),
    },
    {
      label: "Lifetime",
      value: <LifecycleBar item={item} size="md" empty="No dates" />,
    },
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
                className="link"
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
