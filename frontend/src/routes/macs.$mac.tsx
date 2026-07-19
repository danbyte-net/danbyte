import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { useMemo, useState } from "react"

import { api, type MacDetail, type MacObjectDetail } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/kv-card"
import { TagList } from "@/components/cells/tag-list"
import { CatalogCell } from "@/components/cells/catalog-cell"
import { DataTable, SortHeader } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { MacObjectDialog } from "@/components/mac-object-dialog"
import { MacObjectDeleteDialog } from "@/components/mac-object-delete-dialog"
import {
  useCustomFieldDefs,
  hasCustomValue,
  formatCustomValue,
} from "@/components/custom-field-display"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/macs/$mac")({ component: MacDetailPage })

type MacInterface = MacDetail["interfaces"][number]
type MacIp = MacDetail["ips"][number]

function MacDetailPage() {
  const { mac } = Route.useParams()
  const q = useQuery({
    queryKey: ["mac", mac],
    queryFn: () => api<MacDetail>(`/api/macs/${encodeURIComponent(mac)}/`),
  })

  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body data={q.data} />
}

function Body({ data }: { data: MacDetail }) {
  const { canDo } = useMe()
  const canAdd = canDo("macaddress", "add")
  const canEdit = canDo("macaddress", "change")
  const canDelete = canDo("macaddress", "delete")

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<MacObjectDetail | null>(null)
  const [deleting, setDeleting] = useState<MacObjectDetail | null>(null)

  async function copy() {
    const ok = await copyText(data.mac)
    if (ok) toast.success(`Copied ${data.mac}`)
    else toast.error("Couldn't copy — clipboard blocked by the browser")
  }

  const interfaceColumns = useMemo<ColumnDef<MacInterface>[]>(
    () => buildInterfaceColumns(),
    []
  )
  const ipColumns = useMemo<ColumnDef<MacIp>[]>(() => buildIpColumns(), [])

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild className="h-6 px-1">
            <Link to="/macs">
              <ChevronLeft className="h-3 w-3" /> MAC addresses
            </Link>
          </Button>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <span className="font-mono font-semibold tracking-tight text-foreground">
            {data.mac}
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={copy}>
            <Copy className="h-3.5 w-3.5" /> Copy MAC
          </Button>
          {canAdd && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> Add object
            </Button>
          )}
        </div>
      </header>

      <section className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-6 py-5">
        <div className="font-mono text-2xl font-semibold tracking-tight">
          {data.mac}
        </div>
        {data.objects.length > 0 && (
          <Badge variant="secondary">
            {data.objects.length} object{data.objects.length === 1 ? "" : "s"}
          </Badge>
        )}
        <Badge variant="secondary">
          {data.interfaces.length} interface
          {data.interfaces.length === 1 ? "" : "s"}
        </Badge>
        <Badge variant="secondary">
          {data.ips.length} IP{data.ips.length === 1 ? "" : "s"}
        </Badge>
      </section>

      <div className="min-h-0 flex-1 space-y-8 overflow-auto p-4 lg:p-6">
        <section className="space-y-3">
          <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            MAC objects
          </h2>
          {data.objects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No MAC object yet — this address is only known from a recorded
              interface or IP.{" "}
              {canAdd && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="text-primary hover:underline"
                >
                  Create one
                </button>
              )}{" "}
              to attach a description, tags, or custom fields.
            </p>
          ) : (
            <div className="grid gap-3">
              {data.objects.map((obj) => (
                <MacObjectCard
                  key={obj.id}
                  obj={obj}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  onEdit={() => setEditing(obj)}
                  onDelete={() => setDeleting(obj)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Interfaces
          </h2>
          {data.interfaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No interface uses this MAC.
            </p>
          ) : (
            <DataTable
              data={data.interfaces}
              columns={interfaceColumns}
              tableId="mac-interfaces"
              flexColumn="name"
            />
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Paired IPs
          </h2>
          {data.ips.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No IP is paired with this MAC.
            </p>
          ) : (
            <DataTable
              data={data.ips}
              columns={ipColumns}
              tableId="mac-ips"
              flexColumn="device"
            />
          )}
        </section>
      </div>

      <MacObjectDialog
        open={creating}
        onOpenChange={setCreating}
        presetMac={data.mac}
      />
      <MacObjectDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        object={editing}
      />
      <MacObjectDeleteDialog
        object={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

function MacObjectCard({
  obj,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  obj: MacObjectDetail
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            {obj.numid != null && (
              <span className="num font-mono text-muted-foreground">
                #{obj.numid}
              </span>
            )}
            {obj.assigned_interface ? (
              <span className="flex items-center gap-1.5">
                <Link
                  to="/devices/$id"
                  params={{ id: obj.assigned_interface.device.id }}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {obj.assigned_interface.device.name}
                </Link>
                <span className="text-muted-foreground">:</span>
                <Link
                  to="/interfaces/$id"
                  params={{ id: obj.assigned_interface.id }}
                  className="font-mono text-xs font-medium text-primary hover:underline"
                >
                  {obj.assigned_interface.name}
                </Link>
              </span>
            ) : (
              <Badge variant="secondary">Unassigned</Badge>
            )}
          </div>
          {obj.description && (
            <p className="text-[13px] text-muted-foreground">
              {obj.description}
            </p>
          )}
          {obj.tags.length > 0 && <TagList tags={obj.tags} />}
          <ObjectCustomFields values={obj.custom_fields} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Edit MAC object"
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {canDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              title="Delete MAC object"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Non-empty custom-field values for a MAC object, using the shared primitives
 * (so formatting matches the rest of the app) without the page-section chrome
 * of `CustomFieldValues`. */
function ObjectCustomFields({ values }: { values: Record<string, unknown> }) {
  const q = useCustomFieldDefs("macaddress")
  const defs = q.data?.results ?? []
  const seen = new Set(defs.map((d) => d.key))
  const rows = [
    ...defs
      .filter((d) => hasCustomValue(values[d.key]))
      .map((d) => ({
        key: d.key,
        label: d.label,
        node: formatCustomValue(d, values[d.key]),
      })),
    ...Object.entries(values)
      .filter(([k, v]) => !seen.has(k) && hasCustomValue(v))
      .map(([k, v]) => ({
        key: k,
        label: k,
        node: formatCustomValue(undefined, v),
      })),
  ]
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 pt-1 text-[12px] sm:grid-cols-3">
      {rows.map((r) => (
        <div key={r.key}>
          <dt className="text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            {r.label}
          </dt>
          <dd className="mt-0.5">{r.node}</dd>
        </div>
      ))}
    </dl>
  )
}

function buildInterfaceColumns(): ColumnDef<MacInterface>[] {
  return [
    {
      id: "device",
      accessorFn: (r) => r.device.name,
      header: ({ column }) => <SortHeader column={column} label="Device" />,
      cell: ({ row }) => (
        <Link
          to="/devices/$id"
          params={{ id: row.original.device.id }}
          className="font-mono text-xs hover:underline"
        >
          {row.original.device.name}
        </Link>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Interface" />,
      cell: ({ row }) => (
        <Link
          to="/interfaces/$id"
          params={{ id: row.original.id }}
          className="font-mono font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "enabled",
      accessorKey: "enabled",
      header: "Enabled",
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="secondary">Disabled</Badge>
        ),
    },
  ]
}

function buildIpColumns(): ColumnDef<MacIp>[] {
  return [
    {
      id: "ip",
      accessorFn: (r) => r.ip_address,
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <Link
            to="/ips/$id"
            params={{ id: row.original.id }}
            className="font-mono text-xs font-medium hover:underline"
          >
            {row.original.ip_address}
          </Link>
          <CopyButton value={row.original.ip_address} />
        </div>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <CatalogCell value={row.original.status} />,
    },
    {
      id: "device",
      accessorFn: (r) => r.device?.name ?? "",
      header: "Device",
      cell: ({ row }) => {
        const device = row.original.device
        return device ? (
          <Link
            to="/devices/$id"
            params={{ id: device.id }}
            className="font-mono text-xs hover:underline"
          >
            {device.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: "interface",
      accessorFn: (r) => r.interface?.name ?? "",
      header: "Interface",
      cell: ({ row }) => {
        const iface = row.original.interface
        return iface ? (
          <Link
            to="/interfaces/$id"
            params={{ id: iface.id }}
            className="font-mono text-xs hover:underline"
          >
            {iface.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
  ]
}
