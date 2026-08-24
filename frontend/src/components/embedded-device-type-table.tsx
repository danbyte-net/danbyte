import { Input } from "@/components/ui/input"
import { Search } from "lucide-react"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DeviceType, type Paginated } from "@/lib/api"
import { buildDeviceTypeColumns } from "@/components/columns/device-type-columns"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"

/** The Device types table, embedded on a related object's detail page
 * (manufacturer). `filter` scopes it, e.g. {manufacturer: id}. */
export function EmbeddedDeviceTypeTable({
  filter,
  emptyText = "No device types.",
}: {
  filter: Record<string, string>
  emptyText?: string
}) {
  const qs = useMemo(
    () => new URLSearchParams({ ...filter, page_size: "500" }).toString(),
    [filter]
  )
  const q = useQuery({
    queryKey: ["embedded-device-types", qs],
    queryFn: () => api<Paginated<DeviceType>>(`/api/device-types/?${qs}`),
  })
  // A manufacturer can own hundreds of types - scrolling to find one is the
  // complaint behind #96. Filtering happens on the rows already fetched, so
  // it is instant and needs no extra request.
  const [search, setSearch] = useState("")
  const all = q.data?.results ?? []
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return all
    return all.filter((t) =>
      [t.name, t.part_number, t.model]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    )
  }, [all, search])

  const columns = useMemo<ColumnDef<DeviceType>[]>(
    () =>
      buildDeviceTypeColumns<DeviceType>({
        include: ["name", "part_number", "u_height", "devices"],
        heightHeader: "Height",
      }),
    []
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (all.length === 0)
    return <p className="text-sm text-muted-foreground">{emptyText}</p>

  return (
    <div className="space-y-2">
      {all.length > 8 && (
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute top-2 left-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter types…"
            className="h-8 pl-7 text-xs"
          />
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing matches {`"${search}"`}.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="name"
          tableId="embedded-device-types"
        />
      )}
    </div>
  )
}
