import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import { stackLinkText } from "@/lib/stacks"
import type { StackLinkKind } from "@/lib/stacks"
import { useMe } from "@/lib/use-me"
import { RecordStackCablesDialog } from "@/components/stack-cable-dialog"
import { Button } from "@/components/ui/button"

/**
 * A stack port's derived link off the 3D views (docs/dcim/virtual-chassis.md
 * → On a port's page): `/api/devices/<id>/stack-links/` lists a member's
 * stack and StackPower ports in a ring derived from member order, with the
 * far end - no cable is recorded, so the port's page says where the cable
 * would be and offers Record cable. A recorded cable shows as any cable.
 */

export interface DerivedStackLink {
  kind: StackLinkKind
  name: string
  far: { device: string; device_name: string; port: string; id: string }
  parts: string[]
}

/** The device's derived stack links by port id; `enabled` false asks
 * nothing (a cabled port, a page with no stack). */
export function useDerivedStackLinks(
  deviceId: string | null | undefined,
  enabled = true
) {
  return useQuery({
    queryKey: ["stack-links", deviceId],
    queryFn: () =>
      api<{ ports: Record<string, DerivedStackLink> }>(
        `/api/devices/${deviceId}/stack-links/`
      ),
    enabled: !!deviceId && enabled,
    staleTime: 30_000,
    select: (d) => d.ports,
  })
}

/** The Overview's row value: `Stack cable (derived from member order) →
 * sw3 · StackPort3/1`, the far member linked, and Record cable. */
export function DerivedStackLinkValue({
  portId,
  deviceName,
  link,
}: {
  portId: string
  deviceName: string
  link: DerivedStackLink
}) {
  const { canDo } = useMe()
  const [open, setOpen] = useState(false)
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground">
        {stackLinkText({ kind: link.kind, derived: true })} →
      </span>
      <span className="font-mono text-[13px]">
        <Link
          to="/devices/$id"
          params={{ id: link.far.device }}
          className="link"
        >
          {link.far.device_name}
        </Link>{" "}
        · {link.far.port}
      </span>
      {canDo("cable", "add") && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => setOpen(true)}
        >
          Record cable…
        </Button>
      )}
      <RecordStackCablesDialog
        targets={
          open
            ? [
                {
                  key: `${portId}>${link.far.id}`,
                  line: `${deviceName} · ${link.name} → ${link.far.device_name} · ${link.far.port}`,
                  link: {
                    kind: link.kind,
                    derived: true,
                    parts: link.parts,
                    a: { device: "", port: "", name: link.name, id: portId },
                    b: {
                      device: link.far.device,
                      port: "",
                      name: link.far.port,
                      id: link.far.id,
                    },
                  },
                },
              ]
            : null
        }
        onClose={() => setOpen(false)}
      />
    </span>
  )
}

/** The device tabs' cable cell for a port in a derived link. */
export function DerivedStackNote() {
  return <span className="text-xs text-muted-foreground">derived</span>
}
