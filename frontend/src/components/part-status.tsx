import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { Check } from "lucide-react"

import { api } from "@/lib/api"
import type {
  FacePort,
  FacePorts,
  InventoryItemRow,
  Paginated,
  RackPortState,
  Status,
  StatusMini,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { PointerMenu } from "@/components/pointer-menu"
import type { PointerMenuAt } from "@/components/pointer-menu"
import { StatusBadge } from "@/components/status-badge"
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"

// A hardware part's status - active, failed, spare… from the inventory-item
// status catalog - set from wherever its photo marker shows: the device
// page's photo panel, a rack's elevation, a cabinet's plate, and the 3D
// views' part card. The card carries the statuses as pills; a right-click on
// the marker opens the same choices as a menu. One write (`PATCH
// /api/inventory-items/{id}/`), shown at once in every view that draws the
// part, and confirmed by the server - which checks the user may change the
// part, as for any edit.

/** A hardware marker's part. */
export interface PartRef {
  id: string
  name: string
  /** The device it is in. */
  deviceId: string
  status: StatusMini | null
}

/** The statuses a part may wear: the catalog's, offered to inventory items -
 * the part editor's own cache. */
export function usePartStatuses(enabled = true) {
  return useQuery({
    queryKey: ["statuses", "inventoryitem"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=inventoryitem&picker=1"
      ),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/** Whether this user may set parts' statuses; the server holds each part to
 * the user's row and site scope. */
export function useCanSetPartStatus(): boolean {
  const { canDo } = useMe()
  return canDo("inventoryitem", "change")
}

/** The caches that draw a part's status. */
const PART_KEYS = (deviceId: string): QueryKey[] => [
  ["device-inventory", deviceId],
  ["device-face-ports", deviceId],
  ["rack-port-state"],
  ["cabinet-face-ports"],
]

function withStatus(
  face: FacePorts | undefined,
  partId: string,
  status: StatusMini
): FacePorts | undefined {
  if (!face) return face
  const put = (list: FacePort[]) =>
    list.map((e) => (e.id === partId ? { ...e, status } : e))
  return { front: put(face.front), rear: put(face.rear) }
}

/** Every cache that holds the part, with its new status. */
function patchCaches(qc: QueryClient, part: PartRef, status: StatusMini): void {
  qc.setQueriesData<Paginated<InventoryItemRow>>(
    { queryKey: ["device-inventory", part.deviceId] },
    (page) =>
      page && {
        ...page,
        results: page.results.map((row) =>
          row.id === part.id ? { ...row, status } : row
        ),
      }
  )
  qc.setQueriesData<FacePorts>(
    { queryKey: ["device-face-ports", part.deviceId] },
    (face) => withStatus(face, part.id, status)
  )
  qc.setQueriesData<RackPortState>({ queryKey: ["rack-port-state"] }, (s) => {
    const d = s?.devices[part.deviceId]
    if (!s || !d) return s
    return {
      ...s,
      devices: {
        ...s.devices,
        [part.deviceId]: { ...d, face: withStatus(d.face, part.id, status)! },
      },
    }
  })
  qc.setQueriesData<Record<string, FacePorts>>(
    { queryKey: ["cabinet-face-ports"] },
    (bulk) =>
      bulk?.[part.deviceId]
        ? {
            ...bulk,
            [part.deviceId]: withStatus(bulk[part.deviceId], part.id, status)!,
          }
        : bulk
  )
}

/** Set a part's status: drawn at once everywhere the part shows, put back
 * if the server refuses, then read again from the server. */
export function useSetPartStatus(part: PartRef) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (status: Status) =>
      api<InventoryItemRow>(`/api/inventory-items/${part.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ status_id: status.id }),
      }),
    onMutate: async (status) => {
      const keys = PART_KEYS(part.deviceId)
      await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })))
      const before = keys.flatMap((queryKey) => qc.getQueriesData({ queryKey }))
      patchCaches(qc, part, {
        id: status.id,
        name: status.name,
        color: status.color,
        text_color: status.text_color,
      })
      return { before }
    },
    onError: (err, _status, ctx) => {
      for (const [key, data] of ctx?.before ?? []) qc.setQueryData(key, data)
      apiErrorToast(err, "Couldn't set the part's status")
    },
    onSettled: () => {
      for (const queryKey of PART_KEYS(part.deviceId))
        void qc.invalidateQueries({ queryKey })
      // Setting the status SNMP observed resolves the part's drift.
      void qc.invalidateQueries({
        queryKey: ["device-snmp-drift", part.deviceId],
      })
    },
  })
}

/** The part's status on its card: the catalog's statuses as pills, the
 * current one marked; a press sets it. */
export function PartStatusPicker({
  part,
  className,
}: {
  part: PartRef
  className?: string
}) {
  const statuses = usePartStatuses()
  const set = useSetPartStatus(part)
  const options = statuses.data?.results ?? []
  if (options.length === 0) return null
  return (
    <div
      role="radiogroup"
      aria-label={`Status of ${part.name}`}
      data-part="part-status"
      className={cn("flex flex-wrap gap-1 font-sans", className)}
    >
      {options.map((s) => {
        const current = s.id === part.status?.id
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={current}
            disabled={set.isPending}
            onClick={() => {
              if (!current) set.mutate(s)
            }}
            className={cn(
              "inline-flex items-center gap-0.5 rounded-md p-px transition-opacity",
              current
                ? "ring-1 ring-foreground/40"
                : "opacity-60 hover:opacity-100"
            )}
          >
            <StatusBadge status={s} />
            {current && <Check aria-hidden className="mr-0.5 h-3 w-3" />}
          </button>
        )
      })}
    </div>
  )
}

/** The same choices as menu items, for a right-click menu on the part's
 * marker (`PointerMenu`). */
export function PartStatusMenuItems({ part }: { part: PartRef }) {
  const statuses = usePartStatuses()
  const set = useSetPartStatus(part)
  return (
    <>
      <DropdownMenuLabel className="truncate">
        {part.name} · Status
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={part.status?.id ?? ""}
        onValueChange={(id) => {
          const s = statuses.data?.results.find((x) => x.id === id)
          if (s && id !== part.status?.id) set.mutate(s)
        }}
      >
        {(statuses.data?.results ?? []).map((s) => (
          <DropdownMenuRadioItem key={s.id} value={s.id}>
            <StatusBadge status={s} />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}

/** A hardware marker right-clicked in a 3D view: the device, the marker's
 * name and the panel it is on, at the pointer. */
export interface PartMarkerAt extends PointerMenuAt {
  deviceId: string
  marker: string
  side?: "front" | "rear"
}

/** A 3D view's right-click menu on a hardware marker: its part's statuses,
 * the marker resolved through the device's face ports - the cache the
 * marker's quad is drawn from. */
export function PartMarkerMenu({
  menu,
  onClose,
}: {
  menu: PartMarkerAt | null
  onClose: () => void
}) {
  return (
    <PointerMenu
      menu={menu}
      onClose={onClose}
      label="Part status"
      className="w-48"
    >
      {(at) => <MarkerPartItems at={at} />}
    </PointerMenu>
  )
}

function MarkerPartItems({ at }: { at: PartMarkerAt }) {
  const face = useQuery({
    queryKey: ["device-face-ports", at.deviceId],
    queryFn: () => api<FacePorts>(`/api/devices/${at.deviceId}/face-ports/`),
    staleTime: 30_000,
  })
  const list = at.side
    ? (face.data?.[at.side] ?? [])
    : [...(face.data?.front ?? []), ...(face.data?.rear ?? [])]
  const fp = list.find((p) => p.marker === at.marker)
  if (!fp?.id) return null
  return (
    <PartStatusMenuItems
      part={{
        id: fp.id,
        name: fp.name,
        deviceId: at.deviceId,
        status: fp.status,
      }}
    />
  )
}
