import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { apiAll } from "@/lib/api-all"
import type { PrtgConnection, PrtgSensor } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useTableFilters } from "@/components/table-filters"
import { buildPrtgSensorColumns } from "@/components/columns/prtg-sensor-columns"
import { useMe } from "@/lib/use-me"
import { SensorBulkBar } from "./sensor-actions"
import { AddSensorButtons } from "./add-sensor"
import type { AddTarget } from "./add-sensor"

/** Every imported sensor of a connection, or only its alarms (down and
 * degraded, not paused) worst and newest first - the server's order. */
export function usePrtgSensors(
  connection: PrtgConnection,
  variant: "alarms" | "sensors",
  enabled = true
) {
  const path =
    variant === "alarms"
      ? `/api/prtg/sensors/?connection=${connection.id}&alarms=1&ordering=alarms`
      : `/api/prtg/sensors/?connection=${connection.id}&ordering=name`
  return useQuery({
    queryKey: ["prtg-sensors", connection.id, variant],
    queryFn: () => apiAll<PrtgSensor>(path),
    enabled,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  })
}

/**
 * The /prtg page's sensor tables: the shared column factory, a facet rail
 * (state, device, kind, probe / group), search and export. `rowFilter`
 * narrows the rows before the facets count them (Hide paused).
 */
export function PrtgSensorTable({
  connection,
  variant,
  toolbar,
  rowFilter,
  empty,
}: {
  connection: PrtgConnection
  variant: "alarms" | "sensors"
  toolbar?: React.ReactNode
  rowFilter?: (row: PrtgSensor) => boolean
  empty: React.ReactNode
}) {
  const q = usePrtgSensors(connection, variant)
  const { canDo } = useMe()
  const canAct = canDo("prtgsensor", "change")
  const [selected, setSelected] = useState<PrtgSensor[]>([])
  const columns = useMemo(
    () =>
      buildPrtgSensorColumns({
        variant,
        selection: canAct,
        actions: canAct,
      }),
    [variant, canAct]
  )
  const all = q.data?.results
  const rows = useMemo(
    () => (rowFilter ? (all ?? []).filter(rowFilter) : (all ?? [])),
    [all, rowFilter]
  )
  const {
    rail,
    columns: wiredColumns,
    filteredRows,
  } = useTableFilters(columns, rows)
  // Filtered down to one PRTG device: sensors can be added to it here too.
  const target = useMemo((): AddTarget | null => {
    if (variant !== "sensors" || filteredRows.length === rows.length)
      return null
    const ids = new Set(filteredRows.map((r) => r.link))
    const first = filteredRows[0]
    if (ids.size !== 1 || filteredRows.length === 0 || !first.link) return null
    return {
      linkId: first.link,
      connectionId: connection.id,
      name: first.prtg_device || first.objid,
      writeMode: connection.write_mode,
    }
  }, [variant, filteredRows, rows, connection])

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if ((all ?? []).length === 0) return <>{empty}</>

  const tableId = variant === "alarms" ? "prtg-alarms" : "prtg-sensors"
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {(toolbar || target) && (
          <div className="flex items-center justify-end gap-1.5">
            {target && <AddSensorButtons target={target} />}
            {toolbar}
          </div>
        )}
        <DataTable
          tableId={tableId}
          data={filteredRows}
          total={q.data?.count}
          columns={wiredColumns}
          flexColumn="message"
          searchable
          searchPlaceholder="Search sensors…"
          exportName={tableId}
          onSelectedRowsChange={canAct ? setSelected : undefined}
          selectedRows={selected}
          exportTitle={
            variant === "alarms"
              ? `PRTG alarms · ${connection.name}`
              : `PRTG sensors · ${connection.name}`
          }
        />
      </div>
      <SensorBulkBar selected={selected} onCleared={() => setSelected([])} />
    </div>
  )
}

export function NoSensors({ alarms }: { alarms?: boolean }) {
  return alarms ? (
    <EmptyState title="No alarms">
      No sensor is down or degraded in PRTG.
    </EmptyState>
  ) : (
    <EmptyState title="No sensors">
      A status read imports the sensors of every linked device.
    </EmptyState>
  )
}
