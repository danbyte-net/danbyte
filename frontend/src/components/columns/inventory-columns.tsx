import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  HostPackage,
  InventoryHostResult,
  InventoryProfile,
  InventoryRun,
  InventoryScopeHost,
  PendingHostKey,
} from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import {
  HOST_STATUS_LABELS,
  HostStatusBadge,
  RUN_STATUS_LABELS,
  RunStatusBadge,
  TRANSPORT_LABELS,
} from "@/components/discovery/status"
import { InfoTip } from "@/components/ui/info-tip"

// Built-in discovery (#451 B2): the one column factory per discovery table -
// inventory profiles, runs, a run's hosts, a profile's scope hosts, host
// keys waiting for review and a host's packages.

function labelOf(labels: Record<string, string>, v: string): string {
  return Object.hasOwn(labels, v) ? labels[v] : v
}

export function scheduleLabel(p: InventoryProfile): string {
  if (!p.interval_hours) return "Run now only"
  const every =
    p.interval_hours % 24 === 0
      ? `Every ${p.interval_hours / 24 === 1 ? "day" : `${p.interval_hours / 24} days`}`
      : `Every ${p.interval_hours} h`
  if (!p.window_start && !p.window_end) return every
  const t = (v: string | null) => (v ? v.slice(0, 5) : "")
  return `${every}, ${t(p.window_start) || "00:00"}–${t(p.window_end) || "23:59"}`
}

export function scopeLabel(p: InventoryProfile): string {
  const parts: string[] = []
  const n = (k: number, one: string, many: string) =>
    k ? parts.push(`${k} ${k === 1 ? one : many}`) : null
  n(p.scope.sites.length, "site", "sites")
  n(p.scope.prefixes.length, "prefix", "prefixes")
  n(p.scope.devices.length, "device", "devices")
  n(p.scope.virtual_machines.length, "VM", "VMs")
  return parts.join(", ")
}

export function buildInventoryProfileColumns(): ColumnDef<
  InventoryProfile,
  unknown
>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/discovery/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
      meta: { label: "Name" },
    },
    {
      id: "enabled",
      accessorFn: (p) => (p.enabled ? "on" : "off"),
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => (
        <Badge variant={row.original.enabled ? "success" : "secondary"}>
          {row.original.enabled ? "Enabled" : "Disabled"}
        </Badge>
      ),
      meta: {
        label: "State",
        facet: {
          kind: "enum",
          label: "State",
          get: (p: InventoryProfile) => (p.enabled ? "on" : "off"),
          formatValue: (v) => ({ label: v === "on" ? "Enabled" : "Disabled" }),
        },
      },
    },
    {
      id: "authorised",
      accessorFn: (p) => (p.authorised ? "yes" : "no"),
      header: ({ column }) => <SortHeader column={column} label="Authorised" />,
      cell: ({ row }) =>
        row.original.authorised ? (
          <span className="text-sm whitespace-nowrap">
            {row.original.authorised_by_name}
          </span>
        ) : (
          <Badge variant="warning">Not authorised</Badge>
        ),
      meta: {
        label: "Authorised",
        facet: {
          kind: "enum",
          label: "Authorised",
          get: (p: InventoryProfile) => (p.authorised ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Authorised" : "Not authorised",
          }),
        },
      },
    },
    {
      id: "scope",
      accessorFn: scopeLabel,
      header: "Scope",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {scopeLabel(row.original) || dash}
        </span>
      ),
      meta: { label: "Scope" },
    },
    {
      id: "schedule",
      accessorFn: scheduleLabel,
      header: "Schedule",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {scheduleLabel(row.original)}
        </span>
      ),
      meta: { label: "Schedule" },
    },
    {
      id: "last_run",
      accessorFn: (p) => p.last_run?.created_at ?? "",
      header: ({ column }) => <SortHeader column={column} label="Last run" />,
      cell: ({ row }) => {
        const r = row.original.last_run
        if (!r) return <span className="text-muted-foreground">Never</span>
        return (
          <Link
            to="/discovery/runs/$runId"
            params={{ runId: r.id }}
            className="flex items-center gap-2"
          >
            <RunStatusBadge status={r.status} />
            <TimeCell iso={r.created_at} />
          </Link>
        )
      },
      meta: { label: "Last run" },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.description ? (
          <span className="line-clamp-1 text-xs text-muted-foreground">
            {row.original.description}
          </span>
        ) : (
          dash
        ),
      meta: { label: "Description" },
    },
  ]
}

function count(r: InventoryRun, k: string): number {
  return r.counts[k] ?? 0
}

export type InventoryRunColumnId =
  "run" | "profile" | "trigger" | "hosts" | "ok" | "packages" | "finished"

export function buildInventoryRunColumns(
  opts: { omit?: InventoryRunColumnId[] } = {}
): ColumnDef<InventoryRun, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const cols: (ColumnDef<InventoryRun, unknown> & {
    id: InventoryRunColumnId
  })[] = [
    {
      id: "run",
      accessorKey: "created_at",
      header: ({ column }) => <SortHeader column={column} label="Run" />,
      cell: ({ row }) => (
        <Link
          to="/discovery/runs/$runId"
          params={{ runId: row.original.id }}
          className="flex items-center gap-2 hover:underline"
        >
          <RunStatusBadge status={row.original.status} />
          <TimeCell iso={row.original.created_at} />
        </Link>
      ),
      meta: {
        label: "Run",
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: InventoryRun) => r.status,
          formatValue: (v) => ({ label: labelOf(RUN_STATUS_LABELS, v) }),
        },
      },
    },
    {
      id: "profile",
      accessorFn: (r) => r.profile.name,
      header: ({ column }) => <SortHeader column={column} label="Profile" />,
      cell: ({ row }) => (
        <Link
          to="/discovery/$id"
          params={{ id: row.original.profile.id }}
          className="link"
        >
          {row.original.profile.name}
        </Link>
      ),
      meta: { label: "Profile" },
    },
    {
      id: "trigger",
      accessorFn: (r) => r.trigger,
      header: "Started by",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {row.original.trigger === "schedule"
            ? "Schedule"
            : row.original.started_by_name || "Run now"}
        </span>
      ),
      meta: { label: "Started by" },
    },
    {
      id: "hosts",
      accessorFn: (r) => count(r, "hosts"),
      header: ({ column }) => <SortHeader column={column} label="Hosts" />,
      cell: ({ row }) => (
        <span className="num">{count(row.original, "hosts")}</span>
      ),
      meta: { label: "Hosts" },
    },
    {
      id: "ok",
      accessorFn: (r) => count(r, "ok"),
      header: ({ column }) => <SortHeader column={column} label="Read" />,
      cell: ({ row }) => (
        <span className="num">{count(row.original, "ok")}</span>
      ),
      meta: { label: "Read" },
    },
    {
      id: "packages",
      accessorFn: (r) => count(r, "packages"),
      header: ({ column }) => <SortHeader column={column} label="Packages" />,
      cell: ({ row }) => (
        <span className="num">{count(row.original, "packages")}</span>
      ),
      meta: { label: "Packages" },
    },
    {
      id: "finished",
      accessorFn: (r) => r.finished_at ?? "",
      header: ({ column }) => <SortHeader column={column} label="Finished" />,
      cell: ({ row }) =>
        row.original.finished_at ? (
          <TimeCell iso={row.original.finished_at} />
        ) : (
          dash
        ),
      meta: { label: "Finished" },
    },
  ]
  return cols.filter((c) => !omit.has(c.id))
}

function HostLink({
  device,
  vm,
  tab,
}: {
  device: { id: string; name: string } | null
  vm: { id: string; name: string } | null
  tab?: "packages"
}) {
  if (device)
    return (
      <Link
        to="/devices/$id"
        params={{ id: device.id }}
        search={tab ? { tab } : undefined}
        className="link font-mono"
      >
        {device.name}
      </Link>
    )
  if (vm)
    return (
      <Link
        to="/virtual-machines/$id"
        params={{ id: vm.id }}
        search={tab ? { tab } : undefined}
        className="link font-mono"
      >
        {vm.name}
      </Link>
    )
  return dash
}

const statusFacet = <T extends { status: string }>() => ({
  kind: "enum" as const,
  label: "Status",
  get: (r: T) => r.status,
  formatValue: (v: string) => ({ label: labelOf(HOST_STATUS_LABELS, v) }),
})

export function buildInventoryHostResultColumns(): ColumnDef<
  InventoryHostResult,
  unknown
>[] {
  return [
    {
      id: "host",
      accessorFn: (h) => h.device?.name ?? h.virtual_machine?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Host" />,
      cell: ({ row }) => (
        <HostLink
          device={row.original.device}
          vm={row.original.virtual_machine}
          tab={row.original.status === "ok" ? "packages" : undefined}
        />
      ),
      meta: { label: "Host" },
    },
    {
      id: "address",
      accessorKey: "address",
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) =>
        row.original.address ? (
          <span className="font-mono text-xs">{row.original.address}</span>
        ) : (
          dash
        ),
      meta: { label: "Address" },
    },
    {
      id: "status",
      accessorKey: "status",
      header: ({ column }) => <SortHeader column={column} label="Result" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <HostStatusBadge status={row.original.status} />
          {row.original.key_first_use && (
            <Badge variant="warning" className="whitespace-nowrap">
              Key accepted on first use
            </Badge>
          )}
        </span>
      ),
      meta: { label: "Result", facet: statusFacet<InventoryHostResult>() },
    },
    {
      id: "credential",
      accessorKey: "credential_source",
      header: "Credential",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.credential_source ? (
          <span className="text-sm whitespace-nowrap">
            {credentialSourceLabel(row.original.credential_source)}
          </span>
        ) : (
          dash
        ),
      meta: { label: "Credential" },
    },
    {
      id: "transport",
      accessorKey: "transport",
      header: "Transport",
      enableSorting: false,
      cell: ({ row }) => {
        const h = row.original
        const label = h.transport ? labelOf(TRANSPORT_LABELS, h.transport) : ""
        if (!label && !h.attempts.length) return dash
        return (
          <span className="inline-flex items-center gap-1 text-sm whitespace-nowrap">
            {label || dash}
            {h.attempts.length > 0 && (
              <InfoTip>
                <ul className="space-y-0.5">
                  {h.attempts.map((a, i) => (
                    <li key={i}>
                      <span className="text-foreground">
                        {labelOf(TRANSPORT_LABELS, a.transport)}
                      </span>
                      {": "}
                      {a.outcome === "skipped"
                        ? a.reason
                        : labelOf(HOST_STATUS_LABELS, a.outcome)}
                    </li>
                  ))}
                </ul>
              </InfoTip>
            )}
          </span>
        )
      },
      meta: { label: "Transport" },
    },
    {
      id: "packages",
      accessorKey: "packages",
      header: ({ column }) => <SortHeader column={column} label="Packages" />,
      cell: ({ row }) =>
        row.original.status === "ok" ? (
          <span className="num">{row.original.packages}</span>
        ) : (
          dash
        ),
      meta: { label: "Packages" },
    },
    {
      id: "changes",
      accessorFn: (h) => h.added + h.removed + h.updated,
      header: ({ column }) => <SortHeader column={column} label="Changes" />,
      cell: ({ row }) => {
        const h = row.original
        if (h.status !== "ok") return dash
        return (
          <span className="num text-xs whitespace-nowrap text-muted-foreground">
            +{h.added} −{h.removed} ~{h.updated}
          </span>
        )
      },
      meta: { label: "Changes" },
    },
    {
      id: "message",
      accessorKey: "message",
      header: "Detail",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.message ? (
          <span className="line-clamp-1 text-xs text-muted-foreground">
            {row.original.message}
          </span>
        ) : (
          dash
        ),
      meta: { label: "Detail" },
    },
  ]
}

export function buildInventoryScopeHostColumns(
  opts: { exemptAction?: (h: InventoryScopeHost) => React.ReactNode } = {}
): ColumnDef<InventoryScopeHost, unknown>[] {
  const cols: ColumnDef<InventoryScopeHost, unknown>[] = [
    {
      id: "host",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Host" />,
      cell: ({ row }) => {
        const h = row.original
        const ref = { id: h.id, name: h.name }
        return (
          <HostLink
            device={h.kind === "device" ? ref : null}
            vm={h.kind === "virtual_machine" ? ref : null}
          />
        )
      },
      meta: { label: "Host" },
    },
    {
      id: "kind",
      accessorKey: "kind",
      header: "Type",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {row.original.kind === "device" ? "Device" : "VM"}
        </span>
      ),
      meta: { label: "Type" },
    },
    {
      id: "address",
      accessorKey: "address",
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) =>
        row.original.address ? (
          <span className="font-mono text-xs">{row.original.address}</span>
        ) : (
          dash
        ),
      meta: { label: "Address" },
    },
    {
      id: "credential",
      accessorFn: (h) => h.credential?.name ?? "",
      header: "Credential",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.credential ? (
          <span className="text-sm whitespace-nowrap">
            {row.original.credential_source.startsWith("shared")
              ? credentialSourceLabel(row.original.credential_source)
              : row.original.credential.name}
          </span>
        ) : (
          dash
        ),
      meta: { label: "Credential" },
    },
    {
      id: "status",
      accessorKey: "status",
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => <HostStatusBadge status={row.original.status} />,
      meta: { label: "State", facet: statusFacet<InventoryScopeHost>() },
    },
  ]
  if (opts.exemptAction) {
    const render = opts.exemptAction
    cols.push({
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => render(row.original),
      meta: { label: "Actions" },
    })
  }
  return cols
}

/** "host" → "Host's own", "shared: ops" → "Shared · ops". */
export function credentialSourceLabel(source: string): string {
  if (source === "host") return "Host's own"
  if (source.startsWith("shared: ")) return `Shared · ${source.slice(8)}`
  return source
}

export function buildPendingHostKeyColumns(): ColumnDef<
  PendingHostKey,
  unknown
>[] {
  return [
    selectionColumn<PendingHostKey>(),
    {
      id: "host",
      accessorFn: (k) => k.device?.name ?? k.virtual_machine?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Host" />,
      cell: ({ row }) => (
        <HostLink
          device={row.original.device}
          vm={row.original.virtual_machine}
        />
      ),
      meta: { label: "Host" },
    },
    {
      id: "address",
      accessorKey: "address",
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) =>
        row.original.address ? (
          <span className="font-mono text-xs">{row.original.address}</span>
        ) : (
          dash
        ),
      meta: { label: "Address" },
    },
    {
      id: "key_type",
      accessorKey: "key_type",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs whitespace-nowrap">
          {row.original.key_type}
        </span>
      ),
      meta: { label: "Type" },
    },
    {
      id: "fingerprint",
      accessorKey: "fingerprint",
      header: "Fingerprint",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs break-all">
          {row.original.fingerprint}
        </span>
      ),
      meta: { label: "Fingerprint" },
    },
    {
      id: "state",
      accessorFn: (k) => (k.mismatch ? "mismatch" : "new"),
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) =>
        row.original.mismatch ? (
          <Badge variant="destructive" className="whitespace-nowrap">
            Differs from accepted key
          </Badge>
        ) : (
          <Badge variant="secondary">New</Badge>
        ),
      meta: {
        label: "State",
        facet: {
          kind: "enum",
          label: "State",
          get: (k: PendingHostKey) => (k.mismatch ? "mismatch" : "new"),
          formatValue: (v) => ({
            label: v === "mismatch" ? "Differs from accepted key" : "New",
          }),
        },
      },
    },
    {
      id: "first_seen",
      accessorFn: (k) => k.first_seen ?? "",
      header: ({ column }) => <SortHeader column={column} label="First seen" />,
      cell: ({ row }) =>
        row.original.first_seen ? (
          <TimeCell iso={row.original.first_seen} />
        ) : (
          dash
        ),
      meta: { label: "First seen" },
    },
  ]
}

export function buildHostPackageColumns(): ColumnDef<HostPackage, unknown>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Package" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.name}</span>
      ),
      meta: { label: "Package" },
    },
    {
      id: "version",
      accessorKey: "version",
      header: ({ column }) => <SortHeader column={column} label="Version" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs whitespace-nowrap">
          {row.original.version}
        </span>
      ),
      meta: { label: "Version" },
    },
    {
      id: "publisher",
      accessorKey: "publisher",
      header: ({ column }) => <SortHeader column={column} label="Publisher" />,
      cell: ({ row }) =>
        row.original.publisher ? (
          <span className="text-xs whitespace-nowrap">
            {row.original.publisher}
          </span>
        ) : (
          dash
        ),
      meta: { label: "Publisher" },
    },
    {
      id: "source",
      accessorKey: "source_name",
      header: ({ column }) => <SortHeader column={column} label="Source" />,
      cell: ({ row }) =>
        row.original.source_name &&
        row.original.source_name !== row.original.name ? (
          <span className="font-mono text-xs">{row.original.source_name}</span>
        ) : (
          dash
        ),
      meta: { label: "Source" },
    },
    {
      id: "arch",
      accessorKey: "arch",
      header: ({ column }) => <SortHeader column={column} label="Arch" />,
      cell: ({ row }) =>
        row.original.arch ? (
          <span className="font-mono text-xs">{row.original.arch}</span>
        ) : (
          dash
        ),
      meta: {
        label: "Arch",
        facet: {
          kind: "enum",
          label: "Arch",
          get: (p: HostPackage) => p.arch || "none",
          formatValue: (v) => ({ label: v === "none" ? "None" : v }),
          hideWhenSingle: true,
        },
      },
    },
    {
      id: "first_seen",
      accessorKey: "first_seen",
      header: ({ column }) => <SortHeader column={column} label="First seen" />,
      cell: ({ row }) => <TimeCell iso={row.original.first_seen} />,
      meta: { label: "First seen" },
    },
    {
      id: "last_seen",
      accessorKey: "last_seen",
      header: ({ column }) => <SortHeader column={column} label="Last seen" />,
      cell: ({ row }) => <TimeCell iso={row.original.last_seen} />,
      meta: { label: "Last seen" },
    },
  ]
}
