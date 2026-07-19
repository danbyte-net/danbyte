import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Waypoints } from "lucide-react"

import { api, type Paginated, type Tunnel } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

// The tunnels (VPN overlays) terminating on this device — the "show them in
// general" surface beyond the map. Each row: the tunnel, its encapsulation,
// this device's role in it, and the far ends, linking to the tunnel page.
export function DeviceTunnelsCard({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-tunnels", deviceId],
    queryFn: () =>
      api<Paginated<Tunnel>>(`/api/tunnels/?device=${deviceId}&page_size=100`),
  })
  const tunnels = q.data?.results ?? []
  if (!q.isLoading && tunnels.length === 0) return null

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Waypoints className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Tunnels</h2>
        {tunnels.length > 0 && (
          <Badge variant="secondary">{tunnels.length}</Badge>
        )}
      </div>
      {q.isLoading ? (
        <div className="h-16 animate-pulse bg-muted/30" />
      ) : (
        <ul className="divide-y divide-border">
          {tunnels.map((t) => {
            const mine = t.terminations.find(
              (tt) => tt.interface?.device.id === deviceId
            )
            const others = t.terminations.filter(
              (tt) => tt.interface?.device.id !== deviceId
            )
            return (
              <li key={t.id} className="px-4 py-2 text-[13px]">
                <div className="flex items-center gap-2">
                  <Link
                    to="/tunnels/$id"
                    params={{ id: t.id }}
                    className="font-medium hover:underline"
                  >
                    {t.name}
                  </Link>
                  <Badge variant="outline" className="uppercase">
                    {t.encapsulation_display}
                  </Badge>
                  {mine && (
                    <span className="text-[11px] text-muted-foreground">
                      this device: {mine.role_display}
                    </span>
                  )}
                </div>
                {others.length > 0 && (
                  <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                    ↔{" "}
                    {others
                      .map(
                        (tt) =>
                          tt.interface?.device.name ??
                          tt.vm_interface?.vm.name ??
                          "?"
                      )
                      .join(", ")}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
