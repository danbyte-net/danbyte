import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Building2, Locate, Server } from "lucide-react"

import { api, type StatusMini } from "@/lib/api"
import { StatusBadge } from "@/components/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"

interface DeviceCardData {
  id: string
  name: string
  device_type: {
    name: string
    manufacturer: string | null
    front_image: string | null
    rear_image: string | null
  } | null
  site: { id: string; name: string } | null
  role: { id: string; name: string; slug: string; color: string } | null
  status: StatusMini | null
  primary_ip: { id: string; ip_address: string } | null
}

/** A linked device rendered as the device itself: its faceplate photo standing
 * in for an icon, its name, what it is, and where to reach it. Falls back to the
 * device glyph in the same tile so a type without photos keeps the shape.
 *
 * Used in the task sheet, where "replace this switch" should show the switch. */
export function LinkedDeviceCard({
  deviceId,
  action,
}: {
  deviceId: string
  action?: React.ReactNode
}) {
  const [side, setSide] = useState<"front" | "rear">("front")
  const q = useQuery({
    queryKey: ["device-card", deviceId],
    queryFn: () => api<DeviceCardData>(`/api/devices/${deviceId}/`),
    staleTime: 60_000,
  })
  const dev = q.data
  const front = dev?.device_type?.front_image ?? null
  const rear = dev?.device_type?.rear_image ?? null
  const src = side === "rear" && rear ? rear : (front ?? rear)
  const hardware = dev?.device_type
    ? [dev.device_type.manufacturer, dev.device_type.name]
        .filter(Boolean)
        .join(" ")
    : ""

  return (
    <div className="group flex items-start gap-3 px-3 py-2.5">
      <span className="flex h-11 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
        {src ? (
          <img
            src={src}
            alt={`${dev?.name ?? "Device"} ${side}`}
            className="h-full w-full bg-zinc-950 object-contain"
          />
        ) : (
          <Server className="h-4 w-4 text-muted-foreground" />
        )}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/devices/$id"
            params={{ id: deviceId }}
            className="truncate text-[13px] font-medium text-primary hover:underline"
          >
            {dev?.name ?? (q.isLoading ? "Loading..." : "Unavailable")}
          </Link>
          {dev?.status && <StatusBadge status={dev.status} />}
          {dev?.role && (
            <ColorBadge
              name={dev.role.name}
              color={dev.role.color || undefined}
            />
          )}
        </div>

        {hardware && (
          <p className="truncate text-[11px] text-muted-foreground">
            {hardware}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {dev?.primary_ip && (
            <Link
              to="/ips/$id"
              params={{ id: dev.primary_ip.id }}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <Locate className="h-3 w-3" />
              <span className="num">{dev.primary_ip.ip_address}</span>
            </Link>
          )}
          {dev?.site && (
            <Link
              to="/sites/$id"
              params={{ id: dev.site.id }}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <Building2 className="h-3 w-3" /> {dev.site.name}
            </Link>
          )}
          {front && rear && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setSide(side === "front" ? "rear" : "front")}
            >
              {side === "front" ? "Show rear" : "Show front"}
            </button>
          )}
        </div>
      </div>

      {action}
    </div>
  )
}
