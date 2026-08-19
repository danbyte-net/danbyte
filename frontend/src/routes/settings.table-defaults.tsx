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
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"

export const Route = createFileRoute("/settings/table-defaults")({
  component: TableDefaultsPage,
})

function TableDefaultsPage() {
  const { canManageDeployment, isLoading } = useMe()
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
  return (
    <div className="space-y-6">
      <SettingsHeader title="Table defaults">
        Publish or lock the default column layout for each table in this tenant.
      </SettingsHeader>
      <SettingsCard
        title="Tenant table defaults"
        description={
          <>
            Publish your current column layout as the starting point for
            everyone in this tenant. <span className="font-medium">Lock</span>{" "}
            it to force the layout - users keep their saved layouts but can't
            change locked tables until you unlock.
          </>
        }
      >
        <div className="divide-y rounded-lg border border-border">
          {TABLES.map((t) => (
            <AdminTableRow key={t.id} table={t} />
          ))}
        </div>
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
    <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{table.label}</div>
        <div className="text-[11px] text-muted-foreground">{table.area}</div>
      </div>
      {pref.isForced && (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3" /> Locked
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={busy}
        onClick={() => publish.mutate(false)}
      >
        Publish my layout
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={busy}
        onClick={() => publish.mutate(!pref.isForced)}
      >
        {pref.isForced ? "Unlock" : "Lock"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-destructive"
        disabled={busy}
        onClick={() => clear.mutate()}
      >
        Clear
      </Button>
    </div>
  )
}
