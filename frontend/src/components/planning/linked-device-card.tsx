import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type StatusMini } from "@/lib/api"
import { StatusBadge } from "@/components/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { SegmentedTabs } from "@/components/segmented-tabs"

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

/** One labelled fact. Micro-label plus value beats a guessable glyph - nobody
 * should have to decode an icon to find an IP address. */
function Fact({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10px] tracking-wide text-muted-foreground/70 uppercase">
        {label}
      </span>
      {children}
    </span>
  )
}

/** A linked device rendered as the device itself: identity, what it is, its
 * faceplate photo at a size you can actually read, then the facts you need to
 * go do the work. The photo row is skipped entirely when the device type has no
 * images, so a card never shows an empty picture frame. */
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
    <div className="group space-y-2 p-3">
      <div className="flex items-center gap-2">
        <Link
          to="/devices/$id"
          params={{ id: deviceId }}
          className="link truncate text-[13px] font-medium"
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
        <span className="ml-auto shrink-0">{action}</span>
      </div>

      {hardware && (
        <p className="truncate text-[12px] text-muted-foreground">{hardware}</p>
      )}

      {src && (
        <img
          src={src}
          alt={`${dev?.name ?? "Device"} ${side}`}
          className="max-h-24 w-full rounded-md border border-border bg-zinc-950 object-contain"
        />
      )}

      {(dev?.primary_ip || dev?.site || (front && rear)) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
          {dev?.primary_ip && (
            <Fact label="IP">
              <Link
                to="/ips/$id"
                params={{ id: dev.primary_ip.id }}
                className="num link"
              >
                {dev.primary_ip.ip_address}
              </Link>
            </Fact>
          )}
          {dev?.site && (
            <Fact label="Site">
              <Link
                to="/sites/$id"
                params={{ id: dev.site.id }}
                className="link"
              >
                {dev.site.name}
              </Link>
            </Fact>
          )}
          {front && rear && (
            <SegmentedTabs
              className="ml-auto"
              items={[
                { value: "front", label: "Front" },
                { value: "rear", label: "Rear" },
              ]}
              value={side}
              onValueChange={(v) => setSide(v as "front" | "rear")}
            />
          )}
        </div>
      )}
    </div>
  )
}
