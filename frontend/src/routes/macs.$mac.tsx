import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useUrlTab } from "@/lib/use-url-tab"
import { type ColumnDef } from "@tanstack/react-table"
import { Copy, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useMemo, useState } from "react"

import {
  api,
  type MacDetail,
  type MacObjectDetail,
  type OuiStatus,
} from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CopyButton,
  KvCard,
  dash,
  mono,
  type KvRow,
} from "@/components/kv-card"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { TagList } from "@/components/cells/tag-list"
import { CatalogCell } from "@/components/cells/catalog-cell"
import { DataTable, SortHeader } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { QueryError } from "@/components/query-error"
import { MacObjectDialog } from "@/components/mac-object-dialog"
import { MacObjectDeleteDialog } from "@/components/mac-object-delete-dialog"
import {
  useCustomFieldDefs,
  useHiddenCustomFieldKeys,
  hasCustomValue,
  formatCustomValue,
} from "@/components/custom-field-display"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/macs/$mac")({ component: MacDetailPage })

type MacInterface = MacDetail["interfaces"][number]
type MacVmInterface = MacDetail["vm_interfaces"][number]
type MacIp = MacDetail["ips"][number]
type MacSighting = MacDetail["seen"][number]

const seenColumns: ColumnDef<MacSighting>[] = [
  {
    id: "device",
    accessorFn: (s) => s.device?.name ?? s.vm?.name ?? "",
    header: "Seen by",
    cell: ({ row }) => {
      const s = row.original
      if (s.device)
        return (
          <Link
            to="/devices/$id"
            params={{ id: s.device.id }}
            className="link font-medium"
          >
            {s.device.name}
          </Link>
        )
      if (s.vm)
        return (
          <Link
            to="/virtual-machines/$id"
            params={{ id: s.vm.id }}
            className="link font-medium"
          >
            {s.vm.name}
          </Link>
        )
      return <span className="text-muted-foreground">-</span>
    },
  },
  {
    id: "table",
    accessorKey: "source",
    header: "Table",
    cell: ({ row }) =>
      row.original.source === "arp" ? "ARP" : "MAC (forwarding)",
  },
  {
    id: "detail",
    header: "Detail",
    enableSorting: false,
    cell: ({ row }) => {
      const s = row.original
      if (s.source === "arp")
        return s.ip ? (
          <span className="font-mono">{s.ip}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      return s.port ? (
        <span>
          port <span className="font-mono">{s.port}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">-</span>
      )
    },
  },
]

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

const VENDOR_SOURCE: Record<string, string> = {
  ieee: "IEEE registry",
  custom: "Custom range",
  local: "Locally administered bit",
  override: "Set on the MAC object",
}

function Body({ data }: { data: MacDetail }) {
  const { canDo, canManageDeployment } = useMe()
  const canAdd = canDo("macaddress", "add")
  const canEdit = canDo("macaddress", "change")
  const canDelete = canDo("macaddress", "delete")
  const [tab, setTab] = useUrlTab<
    "overview" | "interfaces" | "ips" | "observed" | "history"
  >("overview")

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<MacObjectDetail | null>(null)
  const [deleting, setDeleting] = useState<MacObjectDetail | null>(null)

  // Only a deployment admin may read the registry status - for everyone else
  // an unknown vendor simply reads as unknown.
  const oui = useQuery({
    queryKey: ["oui-status"],
    queryFn: () => api<OuiStatus>("/api/oui/status/"),
    enabled: canManageDeployment && !data.vendor,
    staleTime: 60_000,
  })

  async function copy() {
    const ok = await copyText(data.mac)
    if (ok) toast.success(`Copied ${data.mac}`)
    else toast.error("Couldn't copy - clipboard blocked by the browser")
  }

  const interfaceColumns = useMemo<ColumnDef<MacInterface>[]>(
    () => buildInterfaceColumns(),
    []
  )
  const vmInterfaceColumns = useMemo<ColumnDef<MacVmInterface>[]>(
    () => buildVmInterfaceColumns(),
    []
  )
  const ipColumns = useMemo<ColumnDef<MacIp>[]>(() => buildIpColumns(), [])
  const vmIfaces = data.vm_interfaces ?? []
  const seen = data.seen ?? []
  const ifaceCount = data.interfaces.length + vmIfaces.length
  const seenDevices = new Set(seen.map((s) => s.device?.id ?? s.vm?.id)).size

  const details: KvRow[] = [
    { label: "MAC address", value: mono(data.mac), copy: data.mac },
    {
      label: "Vendor",
      value: data.vendor ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          {data.vendor.name}
          <span className="text-xs text-muted-foreground">
            {VENDOR_SOURCE[data.vendor.source] ?? data.vendor.source}
          </span>
        </span>
      ) : oui.data && oui.data.prefixes === 0 ? (
        <span className="text-xs text-muted-foreground">
          No OUI registry loaded -{" "}
          <Link to="/settings/admin" className="link">
            load it under MAC vendors
          </Link>
          .
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "Interfaces",
      value: <span className="num">{ifaceCount}</span>,
    },
    {
      label: "Paired IPs",
      value: <span className="num">{data.ips.length}</span>,
    },
    {
      label: "Seen via SNMP",
      value:
        seen.length > 0 ? (
          <span className="num">
            {seen.length} sighting{seen.length === 1 ? "" : "s"} on{" "}
            {seenDevices} device{seenDevices === 1 ? "" : "s"}
          </span>
        ) : (
          dash
        ),
    },
  ]

  return (
    <DetailShell
      backTo="/macs"
      backLabel="MAC addresses"
      title={<span className="font-mono">{data.mac}</span>}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={copy}>
            <Copy className="h-3.5 w-3.5" /> Copy MAC
          </Button>
          {canAdd && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> Add object
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={data.mac}
          mono
          badges={
            <>
              {data.vendor && (
                <Badge variant="secondary">{data.vendor.name}</Badge>
              )}
              {data.objects.length > 0 && (
                <Badge variant="secondary">
                  {data.objects.length} object
                  {data.objects.length === 1 ? "" : "s"}
                </Badge>
              )}
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "interfaces", label: "Interfaces", count: ifaceCount },
        { value: "ips", label: "Paired IPs", count: data.ips.length },
        { value: "observed", label: "Observed", count: seen.length },
        ...(data.objects.length > 0
          ? [{ value: "history", label: "Change log" }]
          : []),
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="MAC address" rows={details} />
          <section className="space-y-3">
            <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              MAC objects
            </h2>
            {data.objects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No MAC object yet - this address is only known from a recorded
                interface or IP.{" "}
                {canAdd && (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="link"
                  >
                    Create one
                  </button>
                )}{" "}
                to attach a description, tags, a vendor override, or custom
                fields.
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
        </div>
      </DetailTab>

      <DetailTab value="interfaces">
        <div className="space-y-8">
          <section className="space-y-3">
            <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Device interfaces
            </h2>
            {data.interfaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No device interface uses this MAC.
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
          {vmIfaces.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                VM interfaces
              </h2>
              <DataTable
                data={vmIfaces}
                columns={vmInterfaceColumns}
                tableId="mac-vm-interfaces"
                flexColumn="name"
              />
            </section>
          )}
        </div>
      </DetailTab>

      <DetailTab value="ips">
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
      </DetailTab>

      <DetailTab value="observed">
        {seen.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No polled device has seen this address in its ARP or MAC table.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Polling saw this address on these devices - observations, not
              records. Every switch on the L2 path learns a host's MAC, so one
              address on several devices is normal.
            </p>
            <DataTable
              data={seen}
              columns={seenColumns}
              tableId="mac-sightings"
              flexColumn="detail"
            />
          </div>
        )}
      </DetailTab>

      {data.objects.length > 0 && (
        <DetailTab value="history">
          <div className="space-y-8">
            {data.objects.map((obj) => (
              <section key={obj.id} className="space-y-3">
                {data.objects.length > 1 && (
                  <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    {obj.assigned_interface
                      ? `${obj.assigned_interface.device.name}:${obj.assigned_interface.name}`
                      : "Unassigned object"}
                  </h2>
                )}
                <ChangeLogPanel objectType="api.macaddress" objectId={obj.id} />
              </section>
            ))}
          </div>
        </DetailTab>
      )}

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
    </DetailShell>
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
                  className="link font-mono text-xs"
                >
                  {obj.assigned_interface.device.name}
                </Link>
                <span className="text-muted-foreground">:</span>
                <Link
                  to="/interfaces/$id"
                  params={{ id: obj.assigned_interface.id }}
                  className="link font-mono text-xs font-medium"
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
  const hiddenCf = useHiddenCustomFieldKeys("macaddress")
  const seen = new Set([...defs.map((d) => d.key), ...hiddenCf])
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
          className="link font-mono text-xs"
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
          className="link font-mono font-medium"
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

function buildVmInterfaceColumns(): ColumnDef<MacVmInterface>[] {
  return [
    {
      id: "vm",
      accessorFn: (r) => r.vm.name,
      header: ({ column }) => (
        <SortHeader column={column} label="Virtual machine" />
      ),
      cell: ({ row }) => (
        <Link
          to="/virtual-machines/$id"
          params={{ id: row.original.vm.id }}
          className="link font-mono text-xs"
        >
          {row.original.vm.name}
        </Link>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Interface" />,
      cell: ({ row }) => (
        <Link
          to="/virtual-machines/$id"
          params={{ id: row.original.vm.id }}
          search={{ tab: "components" }}
          className="link font-mono font-medium"
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
            className="link font-mono text-xs font-medium"
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
            className="link font-mono text-xs"
          >
            {device.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">-</span>
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
            className="link font-mono text-xs"
          >
            {iface.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      },
    },
  ]
}
