import { useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { EolCustomProduct, EolRelease } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormDate,
  FormFooter,
  FormText,
} from "@/components/forms"
import { dash } from "@/components/kv-card"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { EolBadge, useEolSettings } from "@/components/cells/eol-cell"
import { LifetimeBar } from "@/components/cells/lifecycle-cell"
import { RowActions } from "@/components/row-actions"

type CycleRow = EolRelease & { id: string }

/** The cycles of a custom end-of-life product: a table, with Add / Edit /
 * Delete through a dialog. Each change saves the product's whole cycle
 * list; the server checks it, sorts it newest first and redoes the installs
 * and mappings on the product. */
export function EolCyclesEditor({
  product,
  canEdit,
}: {
  product: EolCustomProduct
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const settings = useEolSettings()
  const [editing, setEditing] = useState<EolRelease | "new" | null>(null)
  const save = useMutation({
    mutationFn: (releases: EolRelease[]) =>
      api<EolCustomProduct>(`/api/eol/custom-products/${product.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ releases }),
      }),
    onSuccess: (saved) => {
      qc.setQueryData(["eol-custom-product", product.id], saved)
      qc.invalidateQueries({ queryKey: ["eol-custom-products"] })
      qc.invalidateQueries({ queryKey: ["eol-product"] })
      qc.invalidateQueries({ queryKey: ["application"] })
      qc.invalidateQueries({ queryKey: ["installed-software"] })
      qc.invalidateQueries({ queryKey: ["lifecycle"] })
    },
  })
  const rows: CycleRow[] = useMemo(
    () => product.releases.map((r) => ({ ...r, id: r.name })),
    [product.releases]
  )
  const { mutate } = save
  const releases = product.releases
  const warningDays = settings.data?.warning_days ?? null
  const columns = useMemo(
    () =>
      cycleColumns({
        warningDays,
        onEdit: canEdit ? (r) => setEditing(r) : undefined,
        onDelete: canEdit
          ? (r) =>
              mutate(
                releases.filter((x) => x.name !== r.name),
                {
                  onSuccess: () => toast.success(`Removed cycle ${r.name}`),
                  onError: (err) => apiErrorToast(err),
                }
              )
          : undefined,
      }),
    [warningDays, canEdit, releases, mutate]
  )

  return (
    <div className="space-y-2">
      {rows.length > 0 ? (
        <DataTable
          data={rows}
          columns={columns}
          tableId="eol-product-cycles"
          flexColumn="name"
          embedded
        />
      ) : (
        <EmptyState title="No cycles">
          Add the product's release cycles and their dates.
        </EmptyState>
      )}
      {canEdit && (
        <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
          <Plus className="h-3.5 w-3.5" /> Add cycle
        </Button>
      )}
      {editing && (
        <CycleDialog
          cycle={editing === "new" ? null : editing}
          taken={product.releases
            .map((r) => r.name)
            .filter((n) => editing === "new" || n !== editing.name)}
          saving={save.isPending}
          onOpenChange={(o) => !o && setEditing(null)}
          onSave={(row) => {
            const others = product.releases.filter(
              (r) => editing === "new" || r.name !== editing.name
            )
            save.mutate([...others, row], {
              onSuccess: () => {
                toast.success(
                  editing === "new"
                    ? `Added cycle ${row.name}`
                    : `Updated cycle ${row.name}`
                )
                setEditing(null)
              },
              onError: (err) => apiErrorToast(err),
            })
          }}
        />
      )}
    </div>
  )
}

function DateCell({ value }: { value: string | null | undefined }) {
  const { formatDate } = useDateFormat()
  if (!value) return dash
  return <span className="num whitespace-nowrap">{formatDate(value)}</span>
}

function cycleColumns({
  warningDays,
  onEdit,
  onDelete,
}: {
  warningDays: number | null
  onEdit?: (r: CycleRow) => void
  onDelete?: (r: CycleRow) => void
}): ColumnDef<CycleRow, unknown>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: "Cycle",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.name}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.status ? (
          <EolBadge info={{ status: row.original.status }} />
        ) : (
          dash
        ),
    },
    {
      id: "release_date",
      header: "Released",
      enableSorting: false,
      cell: ({ row }) => <DateCell value={row.original.release_date} />,
    },
    {
      id: "support_until",
      header: "Active support until",
      enableSorting: false,
      cell: ({ row }) => <DateCell value={row.original.support_until} />,
    },
    {
      id: "eol_date",
      header: "End of life",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.eol_date ? (
          <span className="inline-flex items-center gap-2">
            <DateCell value={row.original.eol_date} />
            <LifetimeBar
              start={row.original.release_date}
              end={row.original.eol_date}
              warningDays={warningDays}
            />
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "extended_until",
      header: "Extended support until",
      enableSorting: false,
      cell: ({ row }) => <DateCell value={row.original.extended_until} />,
    },
    {
      id: "latest",
      header: "Latest",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.latest ? (
          <span className="font-mono text-xs">{row.original.latest}</span>
        ) : (
          dash
        ),
    },
    {
      id: "lts",
      header: "LTS",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.lts ? <Badge variant="secondary">LTS</Badge> : dash,
    },
    ...(onEdit || onDelete
      ? [
          {
            id: "actions",
            enableHiding: false,
            enableSorting: false,
            cell: ({ row }) => (
              <RowActions
                onEdit={onEdit ? () => onEdit(row.original) : undefined}
                onDelete={onDelete ? () => onDelete(row.original) : undefined}
              />
            ),
          } satisfies ColumnDef<CycleRow, unknown>,
        ]
      : []),
  ]
}

function CycleDialog({
  cycle,
  taken,
  saving,
  onOpenChange,
  onSave,
}: {
  cycle: EolRelease | null
  taken: string[]
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (row: EolRelease) => void
}) {
  const [name, setName] = useState(cycle?.name ?? "")
  const [released, setReleased] = useState(cycle?.release_date ?? "")
  const [support, setSupport] = useState(cycle?.support_until ?? "")
  const [end, setEnd] = useState(cycle?.eol_date ?? "")
  const [extended, setExtended] = useState(cycle?.extended_until ?? "")
  const [latest, setLatest] = useState(cycle?.latest ?? "")
  const [lts, setLts] = useState(!!cycle?.lts)
  const [reached, setReached] = useState(!!cycle?.eol)
  const trimmed = name.trim()
  const duplicate = taken.includes(trimmed)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {cycle ? `Edit cycle ${cycle.name}` : "Add cycle"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!trimmed || duplicate) return
            onSave({
              name: trimmed,
              label: trimmed,
              release_date: released || null,
              support_until: support || null,
              eol_date: end || null,
              extended_until: extended || null,
              eol: reached,
              lts,
              latest: latest.trim(),
            })
          }}
          className="grid gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormText
              label="Cycle"
              required
              autoFocus={!cycle}
              mono
              value={name}
              onChange={setName}
              placeholder="3.2"
              info="The version prefix an install's version is matched on: 3.2 takes 3.2.7."
              error={duplicate ? "Already a cycle of this product." : undefined}
            />
            <FormText
              label="Latest version"
              mono
              value={latest}
              onChange={setLatest}
              placeholder="3.2.7"
            />
            <FormDate
              label="Released"
              value={released}
              onChange={setReleased}
            />
            <FormDate
              label="Active support until"
              value={support}
              onChange={setSupport}
            />
            <FormDate label="End of life" value={end} onChange={setEnd} />
            <FormDate
              label="Extended support until"
              value={extended}
              onChange={setExtended}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <FormCheckbox label="LTS" checked={lts} onChange={setLts} />
            <FormCheckbox
              label="End of life reached"
              info="For a cycle without an end-of-life date."
              checked={reached}
              onChange={setReached}
            />
          </div>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={saving}
            submitLabel={cycle ? "Save cycle" : "Add cycle"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
