import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Paginated, PolicyRule } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { buildPolicyRuleColumns } from "@/components/columns/routing-columns"

import { RoutingDeleteDialog } from "./catalog-page"
import { PolicyRuleForm } from "./object-forms"
import { ownerDetailKey, ownerNoun, ownerParam } from "./owner"
import type { RoutingOwner } from "./owner"

// The `ip rule` rows on a device's or VM's Routing tab, edited in place
// through a dialog with the box pre-set.
export function PolicyRulesSection({ owner }: { owner: RoutingOwner }) {
  const { canDo, humanIds } = useMe()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<PolicyRule | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<PolicyRule | null>(null)

  const q = useQuery({
    queryKey: ["policy-rules", owner.kind, owner.id],
    queryFn: () =>
      api<Paginated<PolicyRule>>(
        `/api/routing/ip-rules/?${ownerParam(owner)}&page_size=500`
      ),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["policy-rules"] })
    qc.invalidateQueries({ queryKey: ownerDetailKey(owner) })
  }
  const canEdit = canDo("policyrule", "change")
  const canDelete = canDo("policyrule", "delete")
  const columns = useMemo<ColumnDef<PolicyRule, unknown>[]>(
    () =>
      buildPolicyRuleColumns({
        humanIds,
        omit: ["device"],
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [humanIds, canEdit, canDelete]
  )
  const rows = q.data?.results ?? []
  const close = () => {
    setAdding(false)
    setEditing(null)
  }

  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Policy rules</h2>
        {rows.length > 0 && (
          <span className="num text-xs text-muted-foreground">
            {rows.length}
          </span>
        )}
        <span className="ml-auto">
          {canDo("policyrule", "add") && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add policy rule
            </Button>
          )}
        </span>
      </div>
      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && <Loading />}
      {q.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No policy rules on this {ownerNoun(owner)}.
        </p>
      )}
      {rows.length > 0 && (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="device-policy-rules"
        />
      )}
      <Dialog open={adding || !!editing} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `Edit rule ${editing.priority}`
                : `Add policy rule on ${owner.name}`}
            </DialogTitle>
          </DialogHeader>
          {(adding || editing) && (
            <PolicyRuleForm
              item={editing}
              owner={owner}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
        </DialogContent>
      </Dialog>
      <RoutingDeleteDialog
        item={deleting}
        endpoint="/api/routing/ip-rules/"
        queryKey="policy-rules"
        label={(r) => `Rule ${r.priority}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </section>
  )
}
