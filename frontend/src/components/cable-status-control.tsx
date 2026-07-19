import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type CSSProperties } from "react"
import { Check, ChevronDown } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated, Status, StatusMini } from "@/lib/api"
import { StatusBadge } from "@/components/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { apiErrorToast } from "@/lib/api-toast"

/** Row tint from a cable's status **color** — whatever hex the user assigned to
 * that status, at ~10% alpha. Derived (not a hardcoded name→color map) so it
 * works for any user-defined status naming (e.g. "Installed" vs "Connected").
 * `undefined` (no tint) when there's no cable / status / color. Returns an
 * inline style — pass to `DataTable`'s `rowStyle` (survives striping; hover
 * still wins via the `!important` rule in tokens.css). Shared by the
 * cables/interface/port tables. */
export function cableTint(
  status: StatusMini | null | undefined
): CSSProperties | undefined {
  if (!status) return undefined
  // Prefer the status's own colour (append "2b" ≈ 17% alpha to the #RRGGBB).
  if (status.color) return { backgroundColor: `${status.color}2b` }
  // Fallback for statuses with no colour set: NetBox-style by name, so cabled
  // rows still tint (connected/installed green, planned amber, decom red).
  const byName: Record<string, string> = {
    connected: "#10b981",
    installed: "#10b981",
    active: "#10b981",
    planned: "#f59e0b",
    "not connected": "#71717a",
    disconnected: "#71717a",
    decommissioning: "#ef4444",
  }
  const hex = byName[status.name?.toLowerCase() ?? ""]
  return hex ? { backgroundColor: `${hex}2b` } : undefined
}

/** Inline cable-status switcher: click the badge to move a cable between its
 * available statuses (Connected / Planned / Decommissioning) without opening the
 * edit form. Used in the cables list and the interface/port cable cells. */
export function CableStatusControl({
  cableId,
  status,
  canEdit,
}: {
  cableId: string
  status: StatusMini | null
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const statuses = useQuery({
    queryKey: ["statuses", "cable"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=cable&picker=1"),
    enabled: canEdit,
    staleTime: 5 * 60_000,
  })
  const setStatus = useMutation({
    mutationFn: (statusId: string) =>
      api<unknown>(`/api/cables/${cableId}/`, {
        method: "PATCH",
        body: JSON.stringify({ status_id: statusId }),
      }),
    // A cable's status shows on cables, interfaces and ports — refresh broadly.
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: unknown) => apiErrorToast(e, "Could not change status"),
  })
  if (!canEdit) return <StatusBadge status={status} />
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Ghost trigger so it sits flush with the sibling row-action buttons;
            the coloured badge itself carries the meaning. */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-1.5"
          onClick={(e) => e.stopPropagation()}
          title="Change cable status"
        >
          {status ? (
            <StatusBadge status={status} />
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Set status
            </span>
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {(statuses.data?.results ?? []).map((s) => {
          const active = s.id === status?.id
          return (
            <DropdownMenuItem
              key={s.id}
              disabled={setStatus.isPending || active}
              onSelect={() => setStatus.mutate(s.id)}
              className="gap-2"
            >
              <ColorBadge name={s.name} color={s.color || undefined} />
              {active && (
                <Check className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
