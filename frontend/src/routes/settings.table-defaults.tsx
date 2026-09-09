import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Lock } from "lucide-react"
import { toast } from "sonner"

import { TABLES, type TableMeta } from "@/lib/tables"
import {
  useTablePreference,
  putTableDefault,
  deleteTableDefault,
} from "@/lib/use-table-preference"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"

export const Route = createFileRoute("/settings/table-defaults")({
  component: TableDefaultsPage,
})

function TableDefaultsPage() {
  const { canManageDeployment, isLoading } = useMe()
  const [q, setQ] = useState("")

  // Fifty tables in one flat list, each repeating its area underneath the
  // name and throwing its actions at the far edge of a full-width card, was
  // unreadable. Grouping by area drops the repetition, and the narrower
  // column puts the actions back beside the name they act on.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = (t: TableMeta) =>
      !needle ||
      t.label.toLowerCase().includes(needle) ||
      t.area.toLowerCase().includes(needle)
    const byArea = new Map<string, TableMeta[]>()
    for (const t of TABLES.filter(match)) {
      const list = byArea.get(t.area) ?? []
      list.push(t)
      byArea.set(t.area, list)
    }
    return [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [q])

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManageDeployment) {
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to manage tenant table defaults.
      </p>
    )
  }

  const total = groups.reduce((n, [, list]) => n + list.length, 0)
  return (
    <div className="max-w-3xl space-y-4">
      <SettingsHeader title="Table layouts">
        The starting column layout everyone in this tenant gets, per table.
      </SettingsHeader>

      <SettingsCard
        title="Tenant defaults"
        description={
          <>
            Publish your current column layout as the starting point for
            everyone. <span className="font-medium">Lock</span> it to force the
            layout - people keep their saved layouts but can't change a locked
            table until you unlock it.
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter tables…"
            className="h-8 max-w-xs"
          />
          <span className="text-[11px] text-muted-foreground">
            {total} of {TABLES.length}
          </span>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          groups.map(([area, list]) => (
            <div key={area} className="grid gap-1.5">
              <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {area}
              </h3>
              <div className="divide-y divide-border rounded-md border border-border">
                {list.map((t) => (
                  <AdminTableRow key={t.id} table={t} />
                ))}
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </div>
  )
}

function AdminTableRow({ table }: { table: TableMeta }) {
  const qc = useQueryClient()
  const pref = useTablePreference(table.id)
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["col-pref", table.id] })

  const publish = useMutation({
    mutationFn: (forced: boolean) =>
      putTableDefault(table.id, {
        order: pref.order,
        hidden: pref.hidden,
        forced,
      }),
    onSuccess: (_d, forced) => {
      toast.success(
        forced
          ? `Locked ${table.label} layout for the tenant`
          : `Published ${table.label} default`
      )
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const clear = useMutation({
    mutationFn: () => deleteTableDefault(table.id),
    onSuccess: () => {
      toast.success(`Cleared ${table.label} default`)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const busy = publish.isPending || clear.isPending

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{table.label}</span>
      {pref.isForced && (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3" /> Locked
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={busy}
        onClick={() => publish.mutate(false)}
      >
        Publish
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={busy}
        onClick={() => publish.mutate(!pref.isForced)}
      >
        {pref.isForced ? "Unlock" : "Lock"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs text-destructive"
        disabled={busy}
        onClick={() => clear.mutate()}
      >
        Clear
      </Button>
    </div>
  )
}
