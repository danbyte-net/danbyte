import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useState } from "react"
import { toast } from "sonner"

import {
  api,
  type DnsRecord,
  type IPAddress,
  type Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { IpPicker } from "@/components/ip-picker"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { DataTable, SortHeader } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { dash } from "@/components/cells/dash"
import { EmptyState } from "@/components/empty-state"
import { KvCard, mono, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import { TimeCell } from "@/components/cells/time-ago"
import {
  DnsRecordsTable,
  DnsTypeBadge,
} from "@/components/integrations/dns-records-table"
import { useUrlTab } from "@/lib/use-url-tab"

const TABS = ["overview", "records", "addresses"] as const
type Tab = (typeof TABS)[number]

export const Route = createFileRoute("/dns-names/$name")({
  component: DnsNamePage,
  validateSearch: (s: Record<string, unknown>) => ({
    zone: typeof s.zone === "string" ? s.zone : undefined,
  }),
})

function DnsNamePage() {
  const { name } = Route.useParams()
  const { zone } = Route.useSearch()
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)

  // Records for this exact name. `?name=` is exact server-side; `search` would
  // also return web01 for web.
  const records = useQuery({
    queryKey: ["dns-records", "name", name, zone],
    queryFn: () =>
      api<Paginated<DnsRecord>>(
        `/api/dns-records/?name=${encodeURIComponent(name)}${
          zone ? `&zone=${zone}` : ""
        }&page_size=500`
      ),
  })

  // Addresses carrying this name in IPAM. Fetched regardless of records: a name
  // filled in by reverse-DNS monitoring has no DNS record at all, and landing
  // on a blank page from a link is worse than not linking.
  const ips = useQuery({
    queryKey: ["ips", "dns-name", name],
    queryFn: () =>
      api<Paginated<IPAddress>>(
        `/api/ips/?dns_name=${encodeURIComponent(name)}&page_size=500`
      ),
  })

  const { canDo } = useMe()
  const qc = useQueryClient()
  const [assigning, setAssigning] = useState(false)
  const [pickedIp, setPickedIp] = useState<string | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dns-records"] })
    qc.invalidateQueries({ queryKey: ["ips", "dns-name", name] })
  }

  // Create the IPAM row a DNS record points at. Reuses the record's own import
  // action, which picks the containing prefix and reports when there isn't one.
  const importOne = useMutation({
    mutationFn: (recordId: string) =>
      api<{ ok: boolean; reason?: string }>(
        `/api/dns-records/${recordId}/import/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success("Added to IPAM")
        refresh()
      } else if (r.reason === "no_prefix") {
        toast.error("No prefix covers that address - create one first.")
      } else {
        toast.error("Could not add that address.")
      }
    },
    onError: (e) => apiErrorToast(e),
  })

  // Point an address Danbyte already tracks at this name.
  const assign = useMutation({
    mutationFn: (ipId: string) =>
      api(`/api/ips/${ipId}/`, {
        method: "PATCH",
        body: JSON.stringify({ dns_name: name }),
      }),
    onSuccess: () => {
      toast.success(`Assigned to ${name}`)
      setAssigning(false)
      setPickedIp(null)
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  if (records.isLoading || ips.isLoading)
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  if (records.isError)
    return (
      <div className="p-6">
        <QueryError error={records.error} />
      </div>
    )

  const rows = records.data?.results ?? []
  const ipRows = ips.data?.results ?? []

  const types = [...new Set(rows.map((r) => r.record_type))]
  const zones = [...new Set(rows.map((r) => r.zone_name))]
  const zoneIds = [...new Set(rows.map((r) => r.zone))]
  const managed = rows.length > 0 && rows.every((r) => r.managed)
  // Same name in two zones = an internal and an external view answering
  // differently. Worth calling out; nothing else in Danbyte surfaces it.
  const splitHorizon = zoneIds.length > 1

  // Addresses: records first (they carry status/prefix/holder already), then
  // any IPAM row for this name that no record pointed at.
  const seen = new Set<string>()
  const addresses: {
    key: string
    address: string
    ip: DnsRecord["ip_detail"]
    ipId: string | null
    via: string
  }[] = []
  for (const r of rows) {
    if (r.record_type !== "A" && r.record_type !== "AAAA") continue
    const addr = r.ip ?? r.data
    if (seen.has(addr)) continue
    seen.add(addr)
    addresses.push({
      key: r.id,
      address: addr,
      ip: r.ip_detail,
      ipId: r.ip_address,
      via: r.zone_name,
    })
  }
  for (const ip of ipRows) {
    if (seen.has(ip.ip_address)) continue
    seen.add(ip.ip_address)
    addresses.push({
      key: ip.id,
      address: ip.ip_address,
      ip: {
        id: ip.id,
        ip_address: ip.ip_address,
        status: ip.status ?? null,
        prefix: ip.prefix?.id ?? null,
        prefix_cidr: ip.prefix?.cidr ?? null,
        assigned_to: null,
      },
      ipId: ip.id,
      via: "reverse DNS",
    })
  }

  const kv: KvRow[] = [
    { label: "Name", value: mono(name), copy: name },
    {
      label: "Record types",
      value: types.length ? (
        <span className="flex flex-wrap gap-1">
          {types.map((t) => (
            <DnsTypeBadge key={t} type={t} />
          ))}
        </span>
      ) : (
        <span className="text-muted-foreground">None synced</span>
      ),
    },
    {
      label: splitHorizon ? "Zones" : "Zone",
      value: zones.length ? (
        <span className="flex flex-wrap gap-1.5">
          {rows
            .filter((r, i, a) => a.findIndex((x) => x.zone === r.zone) === i)
            .map((r) => (
              <Link
                key={r.zone}
                to="/dns-zones/$id"
                params={{ id: r.zone }}
                className="link font-mono text-xs"
              >
                {r.zone_name}
              </Link>
            ))}
        </span>
      ) : (
        <span className="text-muted-foreground">Not in a synced zone</span>
      ),
    },
    { label: "Addresses", value: String(addresses.length) },
    {
      label: "Last seen",
      value: rows.some((r) => r.last_seen_at) ? (
        <TimeCell
          iso={
            rows
              .map((r) => r.last_seen_at)
              .filter(Boolean)
              .sort()
              .at(-1) as string
          }
        />
      ) : (
        <span className="text-muted-foreground">Never synced</span>
      ),
    },
  ]

  const addressColumns: ColumnDef<(typeof addresses)[number]>[] = [
    {
      id: "address",
      accessorKey: "address",
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) =>
        row.original.ipId ? (
          <Link
            to="/ips/$id"
            params={{ id: row.original.ipId }}
            className="link font-mono text-xs"
          >
            {row.original.address}
          </Link>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.address} · not in IPAM
          </span>
        ),
    },
    {
      id: "status",
      accessorFn: (r) => r.ip?.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) =>
        row.original.ip?.status ? (
          <StatusBadge status={row.original.ip.status} />
        ) : (
          dash
        ),
    },
    {
      id: "prefix",
      header: "Prefix",
      enableSorting: false,
      cell: ({ row }) => {
        const ip = row.original.ip
        if (!ip?.prefix) return dash
        return (
          <Link
            to="/prefixes/$id"
            params={{ id: ip.prefix }}
            className="link font-mono text-xs"
          >
            {ip.prefix_cidr ?? "prefix"}
          </Link>
        )
      },
    },
    {
      id: "assigned",
      header: "Assigned to",
      enableSorting: false,
      cell: ({ row }) => {
        const to = row.original.ip?.assigned_to
        if (!to) return dash
        return to.kind === "device" ? (
          <Link to="/devices/$id" params={{ id: to.id }} className="link text-xs">
            {to.name}
          </Link>
        ) : (
          <Link
            to="/virtual-machines/$id"
            params={{ id: to.id }}
            className="link text-xs"
          >
            {to.name}
          </Link>
        )
      },
    },
    {
      id: "via",
      header: "Known from",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">{row.original.via}</span>
      ),
    },
  ]
  // Same rule as the records table: only offer the column when some row can
  // use it, so it never renders as an empty sliver.
  if (canDo("ipaddress", "add") && addresses.some((a) => !a.ipId))
    addressColumns.push({
      id: "import",
      header: "",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.ipId ? null : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={importOne.isPending}
            onClick={() => importOne.mutate(row.original.key)}
          >
            Add to IPAM
          </Button>
        ),
    })

  // A plain array on purpose. It sits below the loading/error returns above,
  // so a hook here would run on some renders and not others - which is exactly
  // the "rendered more hooks than during the previous render" crash. Three
  // object literals are not worth memoising anyway.
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "addresses", label: "Addresses", count: addresses.length },
    { value: "records", label: "Records", count: rows.length || undefined },
  ]

  return (
    <DetailShell
      backTo="/dns-records"
      backLabel="DNS records"
      title={name}
      presence={{ type: "dnsname", id: name }}
      actions={
        canDo("ipaddress", "change") ? (
          <Button variant="outline" onClick={() => setAssigning(true)}>
            Assign IP
          </Button>
        ) : undefined
      }
      hero={
        <DetailHero
          title={name}
          mono
          badges={
            <>
              {types.map((t) => (
                <DnsTypeBadge key={t} type={t} />
              ))}
              {managed && (
                <Badge variant="secondary" className="text-[10px]">
                  Managed in Danbyte
                </Badge>
              )}
              {splitHorizon && (
                <Badge variant="outline" className="text-[10px]">
                  Split horizon
                </Badge>
              )}
            </>
          }
          subtitle={
            rows.length
              ? `${rows.length} record${rows.length === 1 ? "" : "s"} in ${
                  zones.length === 1 ? zones[0] : `${zones.length} zones`
                }`
              : "Not in a synced DNS zone"
          }
        />
      }
      tabs={tabs}
      tab={tab}
      onTabChange={(t) => setTab(t as Tab)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="DNS name" rows={kv} />
          {splitHorizon && (
            <div className="rounded-lg border border-border p-4 text-sm">
              <p className="font-medium">This name answers differently per zone</p>
              <p className="mt-1 text-muted-foreground">
                It exists in {zones.length} zones, so what a client resolves
                depends on which server it asks. Use the Records tab to compare
                them.
              </p>
            </div>
          )}
        </div>
      </DetailTab>

      <DetailTab value="addresses">
        {addresses.length === 0 ? (
          <EmptyState title="No addresses for this name">
            Nothing in IPAM carries this name, and no A or AAAA record points at
            it.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <p className="max-w-prose text-sm text-muted-foreground">
              Every address this name resolves to. More than one is normal -
              that is round robin.
            </p>
            <DataTable
              columns={addressColumns}
              data={addresses}
              tableId="dns-name-addresses"
              flexColumn="address"
            />
          </div>
        )}
      </DetailTab>

      <Dialog open={assigning} onOpenChange={setAssigning}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign an IP to {name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Sets the address's DNS name. This records what Danbyte knows - it
            does not create a record on a DNS server.
          </p>
          <IpPicker value={pickedIp} onChange={setPickedIp} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAssigning(false)}>
              Cancel
            </Button>
            <Button
              disabled={!pickedIp || assign.isPending}
              onClick={() => pickedIp && assign.mutate(pickedIp)}
            >
              {assign.isPending ? "Assigning..." : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DetailTab value="records">
        {rows.length === 0 ? (
          <EmptyState title="No DNS records for this name">
            This name is not in a synced DNS zone. It most likely came from
            reverse-DNS monitoring filling in an address's DNS name, which the
            Addresses tab shows.
          </EmptyState>
        ) : (
          <DnsRecordsTable
            rows={rows}
            queryKey={["dns-records", "name", name]}
            showZone
            editable
            tableId="dns-name-records"
            empty="No records."
          />
        )}
      </DetailTab>
    </DetailShell>
  )
}
