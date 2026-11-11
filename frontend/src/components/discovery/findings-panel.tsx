import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Eye, EyeOff } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DiscoveryFinding,
  FindingKind,
  FindingsPage,
  ObservedService,
  RBACAction,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useUrlTableFilters } from "@/components/table-filters"
import {
  FINDING_KIND_LABELS,
  buildFindingColumns,
  buildObservedServiceColumns,
} from "@/components/columns/service-scan-columns"

// The review queue (#451 B3): proposals from service-scan observations -
// add a service, add installed software, map a product to a CPE - and from
// the package inventory - set a host's platform, add an application for
// well-known packages, link packages to an application - each with its
// evidence. Nothing is created until someone accepts it; Ignore hides a
// finding until the observation changes.

type Scope = { run?: string; profile?: string }

/** An icon-only row action, named by its tooltip and aria-label: the
 * queue's columns need the width. */
function RowAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent variant="panel">{label}</TooltipContent>
    </Tooltip>
  )
}

function qs(scope: Scope, extra: Record<string, string> = {}) {
  const p = new URLSearchParams()
  if (scope.run) p.set("run", scope.run)
  if (scope.profile) p.set("profile", scope.profile)
  for (const [k, v] of Object.entries(extra)) p.set(k, v)
  return p.toString()
}

const NEEDS: Record<FindingKind, [string, RBACAction]> = {
  service: ["service", "add"],
  software: ["installedsoftware", "add"],
  cpe: ["application", "change"],
  platform: ["device", "change"],
  application: ["application", "add"],
  link: ["application", "change"],
}

export function FindingsPanel({
  scope = {},
  tableId = "discovery-findings",
}: {
  scope?: Scope
  tableId?: string
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [showIgnored, setShowIgnored] = useState(false)
  const key = ["discovery", "findings", scope, showIgnored] as const
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      apiAll<DiscoveryFinding>(
        `/api/discovery/findings/?${qs(scope, showIgnored ? { ignored: "true" } : {})}`
      ) as Promise<FindingsPage>,
  })
  const [selected, setSelected] = useState<DiscoveryFinding[]>([])
  const kinds = new Set(selected.map((f) => f.kind))
  const sameKind = kinds.size === 1 ? [...kinds][0] : null
  const may = (k: FindingKind) =>
    k === "platform"
      ? canDo("device", "change") || canDo("virtualmachine", "change")
      : canDo(...NEEDS[k])

  const done = () => {
    setSelected([])
    qc.invalidateQueries({ queryKey: ["discovery", "findings"] })
  }
  const accept = useMutation({
    mutationFn: async (rows: DiscoveryFinding[]) => {
      const cpe = rows.filter((f) => f.kind === "cpe")
      const rest = rows.filter((f) => f.kind !== "cpe")
      let created = 0
      let refused: { id: string; reason: string }[] = []
      if (rest.length) {
        const r = await api<{
          created: unknown[]
          refused: { id: string; reason: string }[]
        }>("/api/discovery/findings/accept/", {
          method: "POST",
          body: JSON.stringify({ ids: rest.map((f) => f.id) }),
        })
        created += r.created.length
        refused = r.refused
      }
      if (cpe.length) {
        // Product mappings go through the vulnerability data's own path.
        const r = await api<{ created: unknown[] }>(
          "/api/vulnerabilities/mappings/bulk-create/",
          {
            method: "POST",
            body: JSON.stringify(
              cpe.map((f) => ({
                application: f.proposal.application?.id,
                identifier: f.proposal.identifier,
              }))
            ),
          }
        )
        created += r.created.length
      }
      return { created, refused }
    },
    onSuccess: ({ created, refused }) => {
      toast.success(`${created} accepted`)
      if (refused.length)
        toast.warning(`${refused.length} refused: ${refused[0].reason}`)
      done()
    },
    onError: (err) => apiErrorToast(err),
  })
  const ignore = useMutation({
    mutationFn: ({ rows, on }: { rows: DiscoveryFinding[]; on: boolean }) =>
      api<{ done: string[]; refused: { id: string; reason: string }[] }>(
        "/api/discovery/findings/ignore/",
        {
          method: "POST",
          body: JSON.stringify({ ids: rows.map((f) => f.id), ignore: on }),
        }
      ),
    onSuccess: (r, v) => {
      toast.success(`${r.done.length} ${v.on ? "ignored" : "shown again"}`)
      done()
    },
    onError: (err) => apiErrorToast(err),
  })
  const busy = accept.isPending || ignore.isPending

  const columns = useMemo(
    () =>
      buildFindingColumns({
        actions: (f) =>
          may(f.kind) ? (
            <span className="flex justify-end gap-0.5">
              {!f.ignored && (
                <RowAction
                  label="Accept"
                  disabled={busy}
                  onClick={() => accept.mutate([f])}
                >
                  <Check className="size-4" />
                </RowAction>
              )}
              <RowAction
                label={f.ignored ? "Show" : "Ignore"}
                disabled={busy}
                onClick={() => ignore.mutate({ rows: [f], on: !f.ignored })}
              >
                {f.ignored ? (
                  <Eye className="size-4" />
                ) : (
                  <EyeOff className="size-4" />
                )}
              </RowAction>
            </span>
          ) : null,
      }),
    [busy, canDo]
  )
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const n = selected.length
  const openRows = selected.filter((f) => !f.ignored)
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!sameKind || !openRows.length || busy || !may(sameKind)}
            onClick={() => accept.mutate(openRows)}
          >
            {accept.isPending
              ? "Accepting…"
              : sameKind && n
                ? `Accept ${openRows.length} · ${FINDING_KIND_LABELS[sameKind]}`
                : "Accept"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!n || busy || [...kinds].some((k) => !may(k))}
            onClick={() => ignore.mutate({ rows: selected, on: true })}
          >
            {ignore.isPending ? "Saving…" : `Ignore ${n || ""}`.trim()}
          </Button>
          <label className="ml-auto flex items-center gap-2 text-xs whitespace-nowrap">
            <Switch
              checked={showIgnored}
              onCheckedChange={setShowIgnored}
              aria-label="Show ignored"
            />
            Show ignored
          </label>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="Nothing to review">
            Proposals show here after a service scan or a package inventory.
          </EmptyState>
        ) : (
          <DataTable
            data={filteredRows}
            columns={wired}
            flexColumn="evidence"
            tableId={tableId}
            searchable
            searchPlaceholder="Search findings…"
            autoColumns={false}
            selectedRows={selected}
            onSelectedRowsChange={setSelected}
          />
        )}
      </div>
    </div>
  )
}

export function ObservedServicesPanel({
  scope = {},
}: {
  scope?: Scope & { device?: string; virtual_machine?: string }
}) {
  const p = new URLSearchParams(qs(scope))
  if ("device" in scope && scope.device) p.set("device", scope.device)
  if ("virtual_machine" in scope && scope.virtual_machine)
    p.set("virtual_machine", scope.virtual_machine)
  const q = useQuery({
    queryKey: ["discovery", "services", p.toString()],
    queryFn: () =>
      apiAll<ObservedService>(`/api/discovery/services/?${p.toString()}`),
  })
  const columns = useMemo(() => buildObservedServiceColumns(), [])
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <EmptyState title="No open ports">
        Ports a service scan finds open show here.
      </EmptyState>
    )
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <DataTable
          data={filteredRows}
          columns={wired}
          flexColumn="banner"
          tableId="discovery-services"
          searchable
          searchPlaceholder="Search ports…"
          autoColumns={false}
        />
      </div>
    </div>
  )
}
