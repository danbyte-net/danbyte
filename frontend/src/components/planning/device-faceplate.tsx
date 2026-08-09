import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { SegmentedTabs } from "@/components/segmented-tabs"

interface DeviceLite {
  id: string
  name: string
  device_type: {
    front_image: string | null
    rear_image: string | null
  } | null
}

/** The front/rear faceplate photo of a linked device, so "replace this switch"
 * comes with a picture of the thing being replaced. Renders nothing when the
 * device type carries no images. */
export function DeviceFaceplate({ deviceId }: { deviceId: string }) {
  const [side, setSide] = useState<"front" | "rear">("front")
  const q = useQuery({
    queryKey: ["device-faceplate", deviceId],
    queryFn: () => api<DeviceLite>(`/api/devices/${deviceId}/`),
    staleTime: 60_000,
  })
  const front = q.data?.device_type?.front_image ?? null
  const rear = q.data?.device_type?.rear_image ?? null
  if (!front && !rear) return null
  const src = side === "rear" && rear ? rear : (front ?? rear)

  return (
    <div className="space-y-1.5 bg-muted/20 px-3 pt-2 pb-3">
      {front && rear && (
        <SegmentedTabs
          items={[
            { value: "front", label: "Front" },
            { value: "rear", label: "Rear" },
          ]}
          value={side}
          onValueChange={(v) => setSide(v as "front" | "rear")}
        />
      )}
      {src && (
        <img
          src={src}
          alt={`${q.data?.name ?? "Device"} ${side}`}
          className="max-h-32 w-full rounded-md border border-border bg-zinc-950 object-contain"
        />
      )}
    </div>
  )
}
