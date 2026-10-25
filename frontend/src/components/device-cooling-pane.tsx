import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { CoolingIntake, CoolingOutflow, Paginated } from "@/lib/api"
import { DataTable, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import {
  buildCoolingIntakeColumns,
  buildCoolingOutflowColumns,
} from "@/components/columns/cooling-component-columns"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  CoolingComponentDialog,
  coolingQueryKey,
} from "@/components/cooling-component-dialog"
import type { CoolingKind } from "@/components/cooling-component-dialog"
import { useRegisterAddActions } from "@/components/device-add-actions"
import { ComponentDeleteDialog } from "@/components/component-delete-dialog"
import { useMe } from "@/lib/use-me"

const BULK_FIELDS = [
  {
    key: "connector",
    label: "Connector",
    kind: "choice" as const,
    choices: "cooling_connectors" as const,
  },
  { key: "label", label: "Label", kind: "text" as const },
  { key: "description", label: "Description", kind: "text" as const },
]

/** A device's cooling intakes and outflows (#434), under Components →
 * Cooling. */
export function DeviceCoolingPane({ deviceId }: { deviceId: string }) {
  const { canDo: can } = useMe()

  const [adding, setAdding] = useState<CoolingKind | null>(null)
  const [editIntake, setEditIntake] = useState<CoolingIntake | null>(null)
  const [editOutflow, setEditOutflow] = useState<CoolingOutflow | null>(null)
  const [delIntake, setDelIntake] = useState<CoolingIntake | null>(null)
  const [delOutflow, setDelOutflow] = useState<CoolingOutflow | null>(null)
  const [selIntakes, setSelIntakes] = useState<CoolingIntake[]>([])
  const [selOutflows, setSelOutflows] = useState<CoolingOutflow[]>([])

  const intakes = useQuery({
    queryKey: coolingQueryKey("intake", deviceId),
    queryFn: () =>
      api<Paginated<CoolingIntake>>(`/api/cooling-intakes/?device=${deviceId}`),
  })
  const outflows = useQuery({
    queryKey: coolingQueryKey("outflow", deviceId),
    queryFn: () =>
      api<Paginated<CoolingOutflow>>(
        `/api/cooling-outflows/?device=${deviceId}`
      ),
  })

  const canEditIntake = can("coolingintake", "change")
  const canDeleteIntake = can("coolingintake", "delete")
  const canEditOutflow = can("coolingoutflow", "change")
  const canDeleteOutflow = can("coolingoutflow", "delete")

  const intakeCols = useMemo<ColumnDef<CoolingIntake>[]>(
    () => [
      selectionColumn<CoolingIntake>(),
      ...buildCoolingIntakeColumns({
        actions: {
          canEdit: canEditIntake,
          canDelete: canDeleteIntake,
          onEdit: setEditIntake,
          onDelete: setDelIntake,
        },
      }),
    ],
    [canEditIntake, canDeleteIntake]
  )
  const outflowCols = useMemo<ColumnDef<CoolingOutflow>[]>(
    () => [
      selectionColumn<CoolingOutflow>(),
      ...buildCoolingOutflowColumns({
        actions: {
          canEdit: canEditOutflow,
          canDelete: canDeleteOutflow,
          onEdit: setEditOutflow,
          onDelete: setDelOutflow,
        },
      }),
    ],
    [canEditOutflow, canDeleteOutflow]
  )

  useRegisterAddActions("cooling", [
    ...(can("coolingintake", "add")
      ? [{ label: "Cooling intake", onClick: () => setAdding("intake") }]
      : []),
    ...(can("coolingoutflow", "add")
      ? [{ label: "Cooling outflow", onClick: () => setAdding("outflow") }]
      : []),
  ])

  const intakeRows = intakes.data?.results ?? []
  const outflowRows = outflows.data?.results ?? []
  const invalidate = [
    coolingQueryKey("intake", deviceId),
    coolingQueryKey("outflow", deviceId),
    ["device-cooling-path", deviceId],
  ]

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Intakes
        </h3>
        {intakes.isError ? (
          <QueryError error={intakes.error} />
        ) : intakes.isLoading ? (
          <Loading />
        ) : intakeRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cooling intakes.</p>
        ) : (
          <DataTable
            data={intakeRows}
            total={intakes.data?.count}
            columns={intakeCols}
            tableId="device-cooling-intakes"
            searchable
            searchPlaceholder="Search intakes…"
            onSelectedRowsChange={setSelIntakes}
          />
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Outflows
        </h3>
        {outflows.isError ? (
          <QueryError error={outflows.error} />
        ) : outflows.isLoading ? (
          <Loading />
        ) : outflowRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cooling outflows.</p>
        ) : (
          <DataTable
            data={outflowRows}
            total={outflows.data?.count}
            columns={outflowCols}
            tableId="device-cooling-outflows"
            searchable
            searchPlaceholder="Search outflows…"
            onSelectedRowsChange={setSelOutflows}
          />
        )}
      </section>

      <ComponentBulkBar
        endpoint="/api/cooling-intakes/"
        kindLabel="cooling intake"
        selected={selIntakes}
        onCleared={() => setSelIntakes([])}
        invalidate={invalidate}
        fields={BULK_FIELDS}
        tags
      />
      <ComponentBulkBar
        endpoint="/api/cooling-outflows/"
        kindLabel="cooling outflow"
        selected={selOutflows}
        onCleared={() => setSelOutflows([])}
        invalidate={invalidate}
        fields={BULK_FIELDS}
        tags
      />

      <CoolingComponentDialog
        kind="intake"
        deviceId={deviceId}
        item={editIntake}
        open={adding === "intake" || !!editIntake}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(null)
            setEditIntake(null)
          }
        }}
      />
      <CoolingComponentDialog
        kind="outflow"
        deviceId={deviceId}
        item={editOutflow}
        open={adding === "outflow" || !!editOutflow}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(null)
            setEditOutflow(null)
          }
        }}
      />

      <ComponentDeleteDialog
        endpoint="cooling-intakes"
        queryKeys={invalidate}
        item={delIntake && { ...delIntake, cable: null }}
        onOpenChange={(o) => !o && setDelIntake(null)}
      />
      <ComponentDeleteDialog
        endpoint="cooling-outflows"
        queryKeys={invalidate}
        item={delOutflow && { ...delOutflow, cable: null }}
        onOpenChange={(o) => !o && setDelOutflow(null)}
      />
    </div>
  )
}
