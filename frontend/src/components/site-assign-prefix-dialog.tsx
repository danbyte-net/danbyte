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

/**
 * Pull an *existing* prefix into a site (sets its `site`). Complements
 * "Add prefix range", which creates a brand-new one. Lists prefixes not
 * already in this site; picking one PATCHes `site_id`.
 */
export function SiteAssignPrefixDialog({
  siteId,
  siteName,
  open,
  onOpenChange,
}: {
  siteId: string
  siteName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [q, setQ] = useState("")

  const prefixesQuery = useQuery({
    queryKey: ["prefixes", "assignable"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/?page_size=500"),
    enabled: open,
  })

  const candidates = useMemo(() => {
    const all = (prefixesQuery.data?.results ?? []).filter(
      (p) => p.site?.id !== siteId
    )
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all.filter(
      (p) =>
        p.cidr.toLowerCase().includes(needle) ||
        (p.description ?? "").toLowerCase().includes(needle) ||
        (p.site?.name ?? "").toLowerCase().includes(needle)
    )
  }, [prefixesQuery.data, q, siteId])

  const assign = useMutation({
    mutationFn: (prefix: Prefix) =>
      api<Prefix>(`/api/prefixes/${prefix.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ site_id: siteId }),
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["site-prefixes", siteId] })
      qc.invalidateQueries({ queryKey: ["prefixes", "assignable"] })
      qc.invalidateQueries({ queryKey: ["site", siteId] })
      toast.success(`Assigned ${saved.cidr} to ${siteName}`)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign an existing prefix</DialogTitle>
          <DialogDescription>
            Move a prefix into <b>{siteName}</b>’s address scope. Pick one to
            assign it; you can assign several in a row.
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
                    {p.site ? (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        in {p.site.name}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        unassigned
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
