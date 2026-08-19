import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api, type InventoryItemRow, type Paginated } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"

/**
 * Roll-up of a device's serial-tracked parts by lifecycle status - "8 Active ·
 * 1 Failed". Surfaces hardware health on the Overview, where a failing disk
 * used to be invisible until you drilled into Components → Hardware.
 *
 * Shares the ["device-inventory", id] cache with the Hardware pane and the
 * Redfish/sensor polls, so it costs no extra request and refreshes the moment
 * a collector flips a status.
 */
export function DeviceHardwareHealth({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-inventory", deviceId],
    queryFn: () =>
      api<Paginated<InventoryItemRow>>(
        `/api/inventory-items/?device=${deviceId}&page_size=500`
      ),
    staleTime: 30_000,
  })

  const groups = useMemo(() => {
    const items = q.data?.results ?? []
    // name → {color, count}; unstatused parts group under "No status".
    const by = new Map<string, { color: string; count: number }>()
    for (const it of items) {
      const key = it.status?.name ?? "No status"
      const cur = by.get(key)
      if (cur) cur.count += 1
      else by.set(key, { color: it.status?.color ?? "", count: 1 })
    }
    return [...by.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [q.data])

  const total = q.data?.results.length ?? 0
  if (total === 0) return <span className="text-muted-foreground">-</span>

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {groups.map(([name, g]) => (
        <ColorBadge
          key={name}
          name={`${g.count} ${name}`}
          color={g.color || undefined}
        />
      ))}
    </span>
  )
}
