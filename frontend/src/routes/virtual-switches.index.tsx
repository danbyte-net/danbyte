import { createFileRoute, Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { type VirtualSwitch } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { buildVirtualSwitchColumns } from "@/components/columns/virtual-switch-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/virtual-switches/")({
  component: VirtualSwitchesPage,
})

function VirtualSwitchesPage() {
  const [q, setQ] = useUrlSearch()
  const [selected, setSelected] = useState<VirtualSwitch[]>([])
  const { canDo } = useMe()
  // The sync fills the switches and their page never deletes one, so the
  // selection edits the VRF and exports - nothing is deleted here.
  const canEdit = canDo("virtualswitch", "change")
  const query = useQuery({
    queryKey: ["virtual-switches", q],
    queryFn: () =>
      apiAll<VirtualSwitch>(
        `/api/virtual-switches/?${new URLSearchParams({ search: q })}`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo(
    () => buildVirtualSwitchColumns<VirtualSwitch>({ selection: canEdit }),
    [canEdit]
  )

  return (
    <ListPageShell
      title="Virtual switches"
      count={query.data ? rows.length : undefined}
      query={query}
      search={{ value: q, onChange: setQ, placeholder: "Filter switches…" }}
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/virtual-topology">Virtual topology</Link>
        </Button>
      }
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No virtual switches.">
          Virtual switches appear here once a virtualization source with{" "}
          <span className="font-medium">
            Sync virtual switches &amp; networks
          </span>{" "}
          enabled has run - the bridges / vSwitches its VMs use are imported
          automatically.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          total={query.data?.count}
          columns={columns}
          tableId="virtual-switches"
          flexColumn="name"
          onSelectedRowsChange={canEdit ? setSelected : undefined}
          selectedRows={canEdit ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/virtual-switches/"
        noun={["switch", "switches"]}
        invalidate={[["virtual-switches"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={false}
        ioType="virtualswitch"
      />
    </ListPageShell>
  )
}
