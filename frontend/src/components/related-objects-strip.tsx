import { Link } from "@tanstack/react-router"

import type { Device } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/** One-line strip of what hangs off a device, shown on its EDIT form.
 *
 * Read-only on purpose: the device page's tabs are where related objects are
 * managed, and an edit form that embeds sub-editors muddies what "Save"
 * covers. These chips just answer "what's attached?" and deep-link there.
 */
export function RelatedObjectsStrip({ device }: { device: Device }) {
  const chips = [
    {
      label: "Interfaces",
      count: device.interface_count,
      to: "/devices/$id",
      search: { tab: "components" as const },
    },
    {
      label: "IPs",
      count: device.ip_count,
      to: "/devices/$id",
      search: { tab: "ips" as const },
    },
    {
      label: "Services",
      count: device.service_count,
      to: "/devices/$id",
      search: { tab: "services" as const },
    },
  ].filter((c) => c.count > 0)
  if (chips.length === 0) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <Link
          key={c.label}
          to={c.to}
          params={{ id: device.id }}
          search={c.search}
        >
          <Badge
            variant="secondary"
            className="gap-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            {c.label}
            <span className="font-mono text-[10px] opacity-70">{c.count}</span>
          </Badge>
        </Link>
      ))}
    </div>
  )
}
