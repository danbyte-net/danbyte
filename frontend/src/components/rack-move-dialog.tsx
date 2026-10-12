import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MoveRight } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { LocationOption, Paginated, Rack, RackMoveResult } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { invalidateSiteViews } from "@/lib/site-cache"
import { useMe } from "@/lib/use-me"
import { useSiteOptions } from "@/lib/use-site-options"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCombobox } from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

const SECTION =
  "text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase"

function moveUrl(rackId: string, dryRun: boolean) {
  return `/api/racks/${rackId}/move/${dryRun ? "?dry_run=1" : ""}`
}

/** "Move to site…" on the rack page (#394): the rack and every device in it
 * go to another site together, keeping their positions. The dialog shows the
 * server's dry run - what goes along, what is cleared, what blocks - before
 * anything is written. */
export function RackMoveButton({ rack }: { rack: Rack }) {
  const { canDo } = useMe()
  const [open, setOpen] = useState(false)
  if (!canDo("rack", "change")) return null
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MoveRight className="h-3.5 w-3.5" /> Move to site…
      </Button>
      {open && <RackMoveDialog rack={rack} onClose={() => setOpen(false)} />}
    </>
  )
}

function RackMoveDialog({
  rack,
  onClose,
}: {
  rack: Rack
  onClose: () => void
}) {
  const qc = useQueryClient()
  const sites = useSiteOptions()
  const [siteId, setSiteId] = useState<string | null>(null)
  const [locationId, setLocationId] = useState<string | null>(null)

  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      api<Paginated<LocationOption>>(`/api/locations/?picker=1&site=${siteId}`),
    enabled: !!siteId,
  })

  const body = JSON.stringify({ site_id: siteId, location_id: locationId })
  const preview = useQuery({
    queryKey: ["rack-move-preview", rack.id, siteId, locationId],
    queryFn: () =>
      api<RackMoveResult>(moveUrl(rack.id, true), { method: "POST", body }),
    enabled: !!siteId,
    retry: false,
  })

  const move = useMutation({
    mutationFn: () =>
      api<RackMoveResult>(moveUrl(rack.id, false), { method: "POST", body }),
    onSuccess: (r) => {
      toast.success(`Moved ${r.rack.name} to ${r.to_site.name}`)
      qc.invalidateQueries({ queryKey: ["rack", rack.id] })
      qc.invalidateQueries({ queryKey: ["racks"] })
      qc.invalidateQueries({ queryKey: ["rack-devices", rack.id] })
      qc.invalidateQueries({ queryKey: ["devices"] })
      invalidateSiteViews(qc, [rack.id, ...r.devices.map((d) => d.id)])
      onClose()
    },
    onError: (err) => {
      apiErrorToast(err)
      void preview.refetch()
    },
  })

  const p = preview.data
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Move {rack.name} to another site</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormCombobox
            label="Site"
            required
            value={siteId}
            onChange={(v) => {
              setSiteId(v)
              setLocationId(null)
            }}
            options={sites.options
              .filter((s) => s.id !== rack.site.id)
              .map((s) => ({ value: s.id, label: s.name }))}
            placeholder="Select a site…"
            searchPlaceholder="Search sites…"
            emptyText="No other sites."
          />
          <FormCombobox
            label="Location"
            value={locationId}
            onChange={setLocationId}
            options={(locations.data?.results ?? []).map((l) => ({
              value: l.id,
              label: l.name,
            }))}
            noneLabel="No location"
            placeholder={siteId ? "Select a location…" : "Pick a site first"}
            searchPlaceholder="Search locations…"
            emptyText="No locations in this site."
            disabled={!siteId}
          />
        </div>

        {siteId && preview.isLoading && <Loading />}
        {siteId && preview.isError && <QueryError error={preview.error} />}
        {p && <MoveImpact result={p} />}

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={move.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!p?.can_move || preview.isFetching || move.isPending}
            onClick={() => move.mutate()}
          >
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MoveImpact({ result: r }: { result: RackMoveResult }) {
  const tiles = r.cleared.floor_plan_tiles
  return (
    <div className="grid gap-4 text-sm">
      {r.blockers.length > 0 && (
        <div className="grid gap-1">
          <span className={SECTION}>
            Blocking the move{" "}
            <Badge variant="destructive">{r.blockers.length}</Badge>
          </span>
          <ul className="grid max-h-48 gap-0.5 overflow-y-auto">
            {r.blockers.map((b, i) => (
              <li key={i}>{b.message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-1">
        <span className={SECTION}>
          Devices going along{" "}
          <Badge variant="secondary">{r.devices.length}</Badge>
        </span>
        {r.devices.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <span className="max-h-32 overflow-y-auto font-mono text-xs">
            {r.devices.map((d) => d.name).join(", ")}
          </span>
        )}
      </div>
      {tiles > 0 && (
        <div className="grid gap-1">
          <span className={SECTION}>Cleared</span>
          <span>
            {tiles} floor-plan tile{tiles === 1 ? "" : "s"} at{" "}
            {r.from_site.name}
          </span>
        </div>
      )}
    </div>
  )
}
