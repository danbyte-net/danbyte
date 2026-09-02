import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"

import {
  api,
  type IPAddress,
  type IPRange,
  type IPRangeAvailable,
} from "@/lib/api"
import { PrefixIpsTable } from "@/components/prefix-ips-table"
import { IpDeleteDialog } from "@/components/ip-delete-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { DhcpBadge } from "@/components/dhcp-badge"
import { Button } from "@/components/ui/button"
import { KvCard, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { DataTable } from "@/components/data-table"
import { IpRangeDeleteDialog } from "@/components/ip-range-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/ip-ranges/$id")({
  component: IpRangeDetail,
})

function IpRangeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["ip-range", id],
    queryFn: () => api<IPRange>(`/api/ip-ranges/${id}/`),
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
  return <Body range={q.data} />
}

function Body({ range: r }: { range: IPRange }) {
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<IPRange | null>(null)
  const [tab, setTab] = useUrlTab<
    "overview" | "available" | "journal" | "history"
  >("overview")
  const goBack = useCallback(() => nav({ to: "/ip-ranges" }), [nav])
  const { canDo } = useMe()

  return (
    <DetailShell
      backTo="/ip-ranges"
      backLabel="IP ranges"
      title={
        <span className="font-mono">
          {r.start_address}–{r.end_address}
        </span>
      }
      presence={{ type: "iprange", id: r.id }}
      actions={
        <>
          {canDo("iprange", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/ip-ranges/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("iprange", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={`${r.start_address} – ${r.end_address}`}
          mono
          badges={
            <>
              <StatusBadge status={r.status} />
              {r.role && (
                <ColorBadge
                  name={r.role.name}
                  color={r.role.color || undefined}
                />
              )}
              {r.dhcp === "exclusion" && <DhcpBadge state="exclusion" />}
            </>
          }
          tags={r.tags.length > 0 && <TagList tags={r.tags} />}
          description={r.description}
          stats={
            <>
              <DetailStat
                label="Size"
                value={
                  <span className="num">
                    {r.size != null ? r.size.toLocaleString() : "-"}
                  </span>
                }
              />
              <DetailStat
                label="Family"
                value={
                  <span className="num">
                    {r.family ? `IPv${r.family}` : "-"}
                  </span>
                }
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "available", label: "Addresses" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <IpRangeOverview range={r} />
      </DetailTab>
      <DetailTab value="available">
        {r.prefix ? (
          <AddressesPanel range={r} prefixId={r.prefix.id} />
        ) : (
          <AvailablePanel rangeId={r.id} prefixId={null} />
        )}
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.iprange" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.iprange" objectId={r.id} />
      </DetailTab>

      <IpRangeDeleteDialog
        range={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

type FreeRow = { address: string; n: number }

const NO_FILTER = new Set<string>()
const noop = () => {}

/** The range as the ordinary IP table: its registered addresses with every
 * IP column (status, tags, assignment…) interleaved with the free ones, which
 * are click-to-add. Compact folds the free rows into "first free · N more". */
function AddressesPanel({ range, prefixId }: { range: IPRange; prefixId: string }) {
  const nav = useNavigate()
  const { canDo } = useMe()
  const [showAvailable, setShowAvailable] = useState(true)
  const [compact, setCompact] = useState(false)
  const [deleting, setDeleting] = useState<IPAddress | null>(null)
  const avail = useQuery({
    queryKey: ["ip-range-available", range.id],
    queryFn: () => api<IPRangeAvailable>(`/api/ip-ranges/${range.id}/available/`),
  })
  const onCreateAt = useCallback(
    (address: string) =>
      nav({ to: "/ips/new", search: { prefix: prefixId, address } }),
    [nav, prefixId]
  )
  const onEdit = useCallback(
    (ip: IPAddress) => nav({ to: "/ips/$id/edit", params: { id: ip.id } }),
    [nav]
  )
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[13px]">
        {avail.data && (
          <span className="text-muted-foreground">
            <span className="num font-medium text-foreground">
              {avail.data.available.toLocaleString()}
            </span>{" "}
            free ·{" "}
            <span className="num font-medium text-foreground">
              {avail.data.used.toLocaleString()}
            </span>{" "}
            used ·{" "}
            <span className="num font-medium text-foreground">
              {avail.data.size.toLocaleString()}
            </span>{" "}
            total
          </span>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={showAvailable}
            onCheckedChange={(v) => setShowAvailable(!!v)}
          />
          <span>Show available</span>
        </label>
        {showAvailable && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={compact} onCheckedChange={(v) => setCompact(!!v)} />
            <span>Compact</span>
          </label>
        )}
      </div>
      <PrefixIpsTable
        prefixId={prefixId}
        statusFilter={NO_FILTER}
        roleFilter={NO_FILTER}
        tagFilter={NO_FILTER}
        onToggleTag={noop}
        search=""
        showAvailable={showAvailable}
        showDhcpPool={false}
        cidr={range.prefix?.cidr ?? ""}
        span={{ start: range.start_address, end: range.end_address }}
        compact={compact}
        hasDescendants={false}
        onEdit={onEdit}
        onDelete={setDeleting}
        onCreateAt={onCreateAt}
        onSelectedRowsChange={noop}
        canEdit={canDo("ipaddress", "change")}
        canDelete={canDo("ipaddress", "delete")}
        canAdd={canDo("ipaddress", "add")}
      />
      <IpDeleteDialog
        ip={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={() => setDeleting(null)}
      />
    </div>
  )
}

function AvailablePanel({
  rangeId,
  prefixId,
}: {
  rangeId: string
  prefixId: string | null
}) {
  const { canDo } = useMe()
  const canAdd = canDo("ipaddress", "add") && !!prefixId
  const q = useQuery({
    queryKey: ["ip-range-available", rangeId],
    queryFn: () =>
      api<IPRangeAvailable>(`/api/ip-ranges/${rangeId}/available/`),
  })
  const rows = useMemo<FreeRow[]>(
    () => (q.data?.results ?? []).map((address, i) => ({ address, n: i + 1 })),
    [q.data]
  )
  // One row per free address; "Add IP" opens the IP form with the range's
  // subnet and this address already filled in.
  const columns = useMemo<ColumnDef<FreeRow>[]>(
    () => [
      {
        id: "n",
        header: "#",
        cell: ({ row }) => (
          <span className="num text-muted-foreground">{row.original.n}</span>
        ),
      },
      {
        id: "address",
        header: "Address",
        cell: ({ row }) => (
          <span className="font-mono text-[13px]">{row.original.address}</span>
        ),
      },
      ...(canAdd
        ? [
            {
              id: "actions",
              header: "",
              cell: ({ row }) => (
                <div className="flex justify-end">
                  <Button asChild size="sm" variant="ghost" className="h-7">
                    <Link
                      to="/ips/new"
                      search={{ prefix: prefixId, address: row.original.address }}
                    >
                      Add IP
                    </Link>
                  </Button>
                </div>
              ),
            } satisfies ColumnDef<FreeRow>,
          ]
        : []),
    ],
    [canAdd, prefixId]
  )

  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Available addresses
      </h2>
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-[13px]">
            <span className="text-muted-foreground">
              <span className="num font-medium text-foreground">
                {q.data.available.toLocaleString()}
              </span>{" "}
              free
            </span>
            <span className="text-muted-foreground">
              <span className="num font-medium text-foreground">
                {q.data.used.toLocaleString()}
              </span>{" "}
              used
            </span>
            <span className="text-muted-foreground">
              <span className="num font-medium text-foreground">
                {q.data.size.toLocaleString()}
              </span>{" "}
              total
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No free addresses in this range.
            </p>
          ) : (
            <>
              <DataTable data={rows} columns={columns} embedded />
              {q.data.truncated && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Showing the first {rows.length} free addresses.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** IP-range attributes, moved out of the page header. */
function IpRangeOverview({ range: r }: { range: IPRange }) {
  const { humanIds } = useMe()
  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "VRF",
      value: <span className="text-xs">{r.vrf ? r.vrf.name : "Global"}</span>,
    },
    {
      label: "Prefix",
      value: r.prefix ? (
        <Link
          to="/prefixes/$id"
          params={{ id: r.prefix.id }}
          className="link font-mono text-[13px]"
        >
          {r.prefix.cidr}
        </Link>
      ) : (
        <span className="text-muted-foreground">-</span>
      ),
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
      <CustomFieldValues
        model="iprange"
        values={r.custom_fields}
        layout="cards"
      />
    </div>
  )
}
