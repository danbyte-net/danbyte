import { Link } from "@tanstack/react-router"

import type { Device, Interface } from "@/lib/api"
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

/** The same idea for an interface: what's attached, and where to manage it.
 * IPs are separate objects with their own status, VRF and DNS - they're
 * assigned from the port's IP tab or the IP form, never edited inside the
 * interface's own Save. */
export function InterfaceRelatedStrip({ iface }: { iface: Interface }) {
  const chips = [
    {
      label: "IPs",
      count: iface.ip_addresses.length,
      to: "/interfaces/$id" as const,
      search: { tab: "ips" as const },
    },
    {
      label: "Cables",
      count: iface.cable_count,
      to: "/interfaces/$id" as const,
      search: { tab: "trace" as const },
    },
  ].filter((c) => c.count > 0)
  if (chips.length === 0) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <Link
          key={c.label}
          to={c.to}
          params={{ id: iface.id }}
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
