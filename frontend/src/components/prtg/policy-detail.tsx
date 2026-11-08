import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink, Pencil } from "lucide-react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { PrtgPolicy, PrtgPolicyMatch } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Section } from "@/components/ui/section"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { PRTG_SYNC_OPTIONS } from "./prtg-sync-select"

const SYNC_LABEL = Object.fromEntries(
  PRTG_SYNC_OPTIONS.map((o) => [o.value, o.label])
)

function filters(p: PrtgPolicy): string {
  const parts: string[] = []
  if (p.match_name) parts.push(`name ${p.match_name}`)
  if (p.match_tags.length) parts.push(`tags ${p.match_tags.join(", ")}`)
  if (p.match_hardware) parts.push(`hardware ${p.match_hardware}`)
  return parts.join(" · ")
}

function ObjectCell({ m }: { m: PrtgPolicyMatch }) {
  return m.kind === "device" ? (
    <Link to="/devices/$id" params={{ id: m.id }} className="link">
      {m.name}
    </Link>
  ) : (
    <span className="inline-flex items-center gap-1.5">
      <Link to="/virtual-machines/$id" params={{ id: m.id }} className="link">
        {m.name}
      </Link>
      <Badge variant="outline">VM</Badge>
    </span>
  )
}

/** The device and VM rows a policy hits, one column factory for the table. */
export function policyMatchColumns(
  policyId: string
): ColumnDef<PrtgPolicyMatch>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => <ObjectCell m={row.original} />,
    },
    {
      id: "site",
      accessorFn: (m) => m.site?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => row.original.site?.name || dash,
    },
    {
      id: "role",
      accessorFn: (m) => m.role?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      cell: ({ row }) => row.original.role?.name || dash,
    },
    {
      id: "platform",
      accessorFn: (m) => m.platform?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Platform" />,
      cell: ({ row }) => row.original.platform?.name || dash,
    },
    {
      id: "prtg_sync",
      accessorKey: "prtg_sync",
      header: ({ column }) => <SortHeader column={column} label="PRTG" />,
      cell: ({ row }) =>
        row.original.prtg_sync === "inherit" ? (
          <span className="text-xs text-muted-foreground">
            {SYNC_LABEL.inherit}
          </span>
        ) : (
          <Badge
            variant={row.original.prtg_sync === "never" ? "secondary" : "info"}
          >
            {SYNC_LABEL[row.original.prtg_sync] ?? row.original.prtg_sync}
          </Badge>
        ),
    },
    {
      id: "linked",
      accessorFn: (m) => (m.linked ? 1 : 0),
      header: ({ column }) => <SortHeader column={column} label="Linked" />,
      cell: ({ row }) =>
        row.original.link ? (
          <a
            href={row.original.link.url}
            target="_blank"
            rel="noreferrer"
            className="link inline-flex items-center gap-1 font-mono text-xs"
          >
            {row.original.link.name || row.original.link.objid}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "group_policy",
      accessorFn: (m) => m.group_policy?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Group from" />,
      cell: ({ row }) => {
        const m = row.original
        if (!m.managed) return <Badge variant="secondary">Not in plan</Badge>
        if (!m.group_policy)
          return (
            <span className="text-xs text-muted-foreground">Connection</span>
          )
        if (m.group_policy.id === policyId)
          return <Badge variant="success">This policy</Badge>
        return (
          <Link
            to="/prtg"
            search={{ tab: "policies", policy: m.group_policy.id }}
            className="link"
          >
            {m.group_policy.name}
          </Link>
        )
      },
    },
  ]
}

/**
 * One policy from the Policies tab: its facts, and every device and VM it
 * matches now - linked in PRTG or not, set to follow policies or not, and
 * which policy decides the group where several match. Opens from
 * `?policy=<id>` on /prtg, so the plan preview can link here.
 */
export function PrtgPolicyDetail({
  policyId,
  onClose,
  onEdit,
}: {
  policyId: string | null
  onClose: () => void
  onEdit?: (p: PrtgPolicy) => void
}) {
  return (
    <Sheet open={!!policyId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-x-hidden overflow-y-auto data-[side=right]:sm:max-w-4xl">
        {policyId && <PolicyDetailBody policyId={policyId} onEdit={onEdit} />}
      </SheetContent>
    </Sheet>
  )
}

function PolicyDetailBody({
  policyId,
  onEdit,
}: {
  policyId: string
  onEdit?: (p: PrtgPolicy) => void
}) {
  const policy = useQuery({
    queryKey: ["prtg-policy", policyId],
    queryFn: () => api<PrtgPolicy>(`/api/prtg/policies/${policyId}/`),
  })
  const matches = useQuery({
    queryKey: ["prtg-policy-matches", policyId],
    queryFn: () =>
      apiAll<PrtgPolicyMatch>(`/api/prtg/policies/${policyId}/matches/`),
  })
  const columns = useMemo(() => policyMatchColumns(policyId), [policyId])
  const p = policy.data
  const rows = matches.data?.results ?? []
  const linked = rows.filter((m) => m.linked).length

  const facts: KvRow[] = p
    ? [
        {
          label: "Applies to",
          value:
            p.scope === "global"
              ? p.scope_display
              : `${p.scope_display} ${p.target_name}`,
        },
        {
          label: "Objects",
          value: [
            p.applies_to_devices ? "Devices" : "",
            p.applies_to_vms ? "VMs" : "",
          ]
            .filter(Boolean)
            .join(", "),
        },
        { label: "Filters", value: filters(p) || dash },
        { label: "Sensor profile", value: p.profile_name || dash },
        { label: "PRTG group", value: p.group_path || p.group_id || dash },
        { label: "Priority", value: <span className="num">{p.priority}</span> },
        {
          label: "Enabled",
          value: p.enabled ? (
            <Badge variant="success">On</Badge>
          ) : (
            <Badge variant="secondary">Off</Badge>
          ),
        },
      ]
    : []

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 pr-8">
          {p?.name ?? "Policy"}
          {p && !p.enabled && <Badge variant="secondary">Off</Badge>}
        </SheetTitle>
      </SheetHeader>
      <div className="grid gap-6 px-4 pb-6">
        {policy.isLoading ? (
          <Loading />
        ) : policy.isError ? (
          <QueryError error={policy.error} />
        ) : (
          <KvCard title="Policy" rows={facts} />
        )}
        <Section
          title={
            <>
              Matches
              {matches.data && (
                <span
                  className="num tracking-normal text-muted-foreground normal-case"
                  data-testid="prtg-policy-match-counts"
                >
                  {rows.length} · {linked} linked
                </span>
              )}
            </>
          }
          actions={
            p &&
            onEdit && (
              <Button size="sm" variant="outline" onClick={() => onEdit(p)}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            )
          }
        >
          {matches.isLoading ? (
            <Loading />
          ) : matches.isError ? (
            <QueryError error={matches.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="No matches">
              No device or VM matches this policy now.
            </EmptyState>
          ) : (
            <DataTable
              tableId="prtg-policy-matches"
              data={rows}
              total={matches.data?.count}
              columns={columns}
              flexColumn="name"
            />
          )}
        </Section>
      </div>
    </>
  )
}
