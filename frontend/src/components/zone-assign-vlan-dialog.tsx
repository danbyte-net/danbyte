import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Search } from "lucide-react"

import { api, type Paginated, type VLAN } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { apiErrorToast } from "@/lib/api-toast"
import { PlanStaged, useSaveObject } from "@/lib/save-object"

/**
 * Pull an *existing* VLAN into a zone (sets its `zone`). Lists VLANs not
 * already in this zone; picking one PATCHes `zone_id`. Mirrors the site
 * "Assign prefix" dialog.
 */
export function ZoneAssignVlanDialog({
  zoneId,
  zoneName,
  open,
  onOpenChange,
}: {
  zoneId: string
  zoneName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const [q, setQ] = useState("")

  const vlansQuery = useQuery({
    queryKey: ["vlans", "assignable"],
    queryFn: () => api<Paginated<VLAN>>("/api/vlans/?page_size=500"),
    enabled: open,
  })

  const candidates = useMemo(() => {
    const all = (vlansQuery.data?.results ?? []).filter(
      (v) => v.zone?.id !== zoneId
    )
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all.filter(
      (v) =>
        String(v.vlan_id).includes(needle) ||
        v.name.toLowerCase().includes(needle) ||
        (v.zone?.name ?? "").toLowerCase().includes(needle)
    )
  }, [vlansQuery.data, q, zoneId])

  const assign = useMutation({
    mutationFn: (vlan: VLAN) =>
      saveObject<VLAN>({
        objectType: "api.vlan",
        endpoint: "/api/vlans/",
        id: vlan.id,
        payload: { zone_id: zoneId },
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vlans"] })
      qc.invalidateQueries({ queryKey: ["zone", zoneId] })
      toast.success(`Assigned VLAN ${saved.vlan_id} · ${saved.name} to ${zoneName}`)
    },
    onError: (err) => {
      if (err instanceof PlanStaged) return
      apiErrorToast(err)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Assign an existing VLAN</DialogTitle>
          <DialogDescription>
            Move a VLAN into <b>{zoneName}</b>. Pick one to assign it; you can
            assign several in a row.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search VLANs…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="max-h-80 overflow-auto rounded-md border border-border">
          {vlansQuery.isLoading ? (
            <p className="p-3 text-xs text-muted-foreground">Loading VLANs…</p>
          ) : candidates.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No VLANs to assign.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    disabled={assign.isPending}
                    onClick={() => assign.mutate(v)}
                    className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-muted/60 disabled:opacity-50"
                  >
                    <span className="font-mono text-[13px]">
                      {v.vlan_id} · {v.name}
                    </span>
                    {v.zone ? (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        in {v.zone.name}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        no zone
                      </span>
                    )}
                    {v.description && (
                      <span className="ml-auto truncate text-[11px] text-muted-foreground">
                        {v.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
