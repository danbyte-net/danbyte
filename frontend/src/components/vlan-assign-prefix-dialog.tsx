import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Search } from "lucide-react"

import { api, type Paginated, type Prefix } from "@/lib/api"
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
 * Pull an *existing* prefix onto a VLAN (sets its `vlan`). Complements
 * "Add prefix", which creates a brand-new one already on the VLAN. Lists
 * prefixes not already here; picking one PATCHes `vlan_id`. Mirrors the site
 * "Assign prefix" dialog.
 */
export function VlanAssignPrefixDialog({
  vlanId,
  vlanLabel,
  open,
  onOpenChange,
}: {
  vlanId: string
  vlanLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const [q, setQ] = useState("")

  const prefixesQuery = useQuery({
    queryKey: ["prefixes", "assignable"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/?page_size=500"),
    enabled: open,
  })

  const candidates = useMemo(() => {
    const all = (prefixesQuery.data?.results ?? []).filter(
      (p) => p.vlan?.id !== vlanId
    )
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all.filter(
      (p) =>
        p.cidr.toLowerCase().includes(needle) ||
        (p.description ?? "").toLowerCase().includes(needle) ||
        (p.vlan ? `vlan ${p.vlan.vlan_id}`.includes(needle) : false)
    )
  }, [prefixesQuery.data, q, vlanId])

  const assign = useMutation({
    mutationFn: (prefix: Prefix) =>
      saveObject<Prefix>({
        objectType: "api.prefix",
        endpoint: "/api/prefixes/",
        id: prefix.id,
        payload: { vlan_id: vlanId },
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vlan-prefixes", vlanId] })
      qc.invalidateQueries({ queryKey: ["prefixes", "assignable"] })
      qc.invalidateQueries({ queryKey: ["vlan", vlanId] })
      toast.success(`Assigned ${saved.cidr} to ${vlanLabel}`)
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
          <DialogTitle>Assign an existing prefix</DialogTitle>
          <DialogDescription>
            Put a prefix on <b>{vlanLabel}</b>. Pick one to assign it; you can
            assign several in a row.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search prefixes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="max-h-80 overflow-auto rounded-md border border-border">
          {prefixesQuery.isLoading ? (
            <p className="p-3 text-xs text-muted-foreground">
              Loading prefixes…
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No prefixes to assign.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={assign.isPending}
                    onClick={() => assign.mutate(p)}
                    className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-muted/60 disabled:opacity-50"
                  >
                    <span className="font-mono text-[13px]">{p.cidr}</span>
                    {p.vlan ? (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        on VLAN {p.vlan.vlan_id}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        no VLAN
                      </span>
                    )}
                    {p.description && (
                      <span className="ml-auto truncate text-[11px] text-muted-foreground">
                        {p.description}
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
