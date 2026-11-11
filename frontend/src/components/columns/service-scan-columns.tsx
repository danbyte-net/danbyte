import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  DiscoveryFinding,
  FindingKind,
  ObservedService,
  ServiceConfidence,
} from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"

// Service scan (#451 B3): one column factory each for observed services
// (open ports a scan found) and the review queue's findings.

export const CONFIDENCE_LABELS: Record<ServiceConfidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
}

const CONFIDENCE_VARIANT = {
  high: "success",
  medium: "warning",
  low: "secondary",
} as const

export function ConfidenceBadge({ value }: { value: ServiceConfidence }) {
  return (
    <Badge variant={CONFIDENCE_VARIANT[value]}>
      {CONFIDENCE_LABELS[value]}
    </Badge>
  )
}

export const SOURCE_LABELS: Record<ObservedService["source"], string> = {
  danbyte: "Danbyte rule",
  recog: "Recog",
  nmap: "nmap",
  banner: "Banner",
  port: "Port number",
}

export const FINDING_KIND_LABELS: Record<FindingKind, string> = {
  service: "Add service",
  software: "Add software",
  cpe: "Map to CPE",
}

function labelOf<T extends string>(labels: Record<T, string>, v: string) {
  return Object.hasOwn(labels, v) ? labels[v as T] : v
}

function Host({
  device,
  vm,
}: {
  device: { id: string; name: string } | null
  vm: { id: string; name: string } | null
}) {
  if (device)
    return (
      <Link
        to="/devices/$id"
        params={{ id: device.id }}
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
        className="link font-mono"
      >
        {vm.name}
      </Link>
    )
  return dash
}

const confidenceFacet = <T extends { confidence: ServiceConfidence }>() => ({
  kind: "enum" as const,
  label: "Confidence",
  get: (r: T) => r.confidence,
  formatValue: (v: string) => ({ label: labelOf(CONFIDENCE_LABELS, v) }),
})

function productLabel(o: { product: string; version: string }) {
  return [o.product, o.version].filter(Boolean).join(" ")
}

export function buildObservedServiceColumns(): ColumnDef<
  ObservedService,
  unknown
>[] {
  return [
    {
      id: "address",
      accessorKey: "address",
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) => (
        <Link
          to="/ips/$id"
          params={{ id: row.original.ip_address }}
          className="link font-mono text-xs"
        >
          {row.original.address}
        </Link>
      ),
      meta: { label: "Address" },
    },
    {
      id: "host",
      accessorFn: (o) => o.device?.name ?? o.virtual_machine?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Host" />,
      cell: ({ row }) => (
        <Host device={row.original.device} vm={row.original.virtual_machine} />
      ),
      meta: { label: "Host" },
    },
    {
      id: "port",
      accessorKey: "port",
      header: ({ column }) => <SortHeader column={column} label="Port" />,
      cell: ({ row }) => (
        <span className="num font-mono text-xs whitespace-nowrap">
          {row.original.protocol}/{row.original.port}
        </span>
      ),
      meta: { label: "Port" },
    },
    {
      id: "service",
      accessorKey: "service_name",
      header: ({ column }) => <SortHeader column={column} label="Service" />,
      cell: ({ row }) =>
        row.original.service_name ? (
          <span className="text-sm whitespace-nowrap">
            {row.original.service_name}
          </span>
        ) : (
          dash
        ),
      meta: {
        label: "Service",
        facet: {
          kind: "enum",
          label: "Service",
          get: (o: ObservedService) => o.service_name || "unknown",
          formatValue: (v) => ({ label: v === "unknown" ? "Unknown" : v }),
        },
      },
    },
    {
      id: "product",
      accessorFn: productLabel,
      header: ({ column }) => <SortHeader column={column} label="Product" />,
      cell: ({ row }) => {
        const o = row.original
        const text = productLabel(o)
        if (!text) return dash
        return (
          <span className="inline-flex items-center gap-1 text-sm whitespace-nowrap">
            {text}
            {o.cpe && (
              <InfoTip>
                <span className="font-mono break-all">{o.cpe}</span>
              </InfoTip>
            )}
          </span>
        )
      },
      meta: { label: "Product" },
    },
    {
      id: "confidence",
      accessorKey: "confidence",
      header: ({ column }) => <SortHeader column={column} label="Confidence" />,
      cell: ({ row }) => <ConfidenceBadge value={row.original.confidence} />,
      meta: { label: "Confidence", facet: confidenceFacet<ObservedService>() },
    },
    {
      id: "source",
      accessorKey: "source",
      header: "Source",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {labelOf(SOURCE_LABELS, row.original.source)}
        </span>
      ),
      meta: {
        label: "Source",
        facet: {
          kind: "enum",
          label: "Source",
          get: (o: ObservedService) => o.source,
          formatValue: (v) => ({ label: labelOf(SOURCE_LABELS, v) }),
        },
      },
    },
    {
      id: "banner",
      accessorFn: (o) => o.banner || o.http.title || o.tls.subject_cn || "",
      header: "Banner",
      enableSorting: false,
      cell: ({ row }) => {
        const o = row.original
        const text =
          o.banner ||
          [o.http.server, o.http.title].filter(Boolean).join(" · ") ||
          (o.tls.subject_cn ? `TLS ${o.tls.subject_cn}` : "")
        return text ? (
          <span className="line-clamp-1 font-mono text-xs text-muted-foreground">
            {text}
          </span>
        ) : (
          dash
        )
      },
      meta: { label: "Banner" },
    },
    {
      id: "last_seen",
      accessorKey: "last_seen",
      header: ({ column }) => <SortHeader column={column} label="Last seen" />,
      cell: ({ row }) =>
        row.original.gone_at ? (
          <Badge variant="secondary">Closed</Badge>
        ) : (
          <TimeCell iso={row.original.last_seen} />
        ),
      meta: { label: "Last seen" },
    },
  ]
}

export function buildFindingColumns(
  opts: { actions?: (f: DiscoveryFinding) => React.ReactNode } = {}
): ColumnDef<DiscoveryFinding, unknown>[] {
  const cols: ColumnDef<DiscoveryFinding, unknown>[] = [
    selectionColumn<DiscoveryFinding>(),
    {
      id: "kind",
      accessorKey: "kind",
      header: ({ column }) => <SortHeader column={column} label="Proposal" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5 text-sm whitespace-nowrap">
          {labelOf(FINDING_KIND_LABELS, row.original.kind)}
          {row.original.ignored && <Badge variant="secondary">Ignored</Badge>}
        </span>
      ),
      meta: {
        label: "Proposal",
        facet: {
          kind: "enum",
          label: "Proposal",
          get: (f: DiscoveryFinding) => f.kind,
          formatValue: (v) => ({ label: labelOf(FINDING_KIND_LABELS, v) }),
        },
      },
    },
    {
      id: "title",
      accessorKey: "title",
      header: ({ column }) => <SortHeader column={column} label="What" />,
      cell: ({ row }) => {
        const f = row.original
        const p = f.proposal
        const what =
          f.kind === "service"
            ? `${p.name} ${p.protocol}/${p.port}`
            : f.kind === "software"
              ? [p.application?.name ?? p.application_name, p.version]
                  .filter(Boolean)
                  .join(" ")
              : p.identifier
        return (
          <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
            <span className={f.kind === "cpe" ? "font-mono text-xs" : ""}>
              {what}
            </span>
            {f.kind === "software" && !p.application && (
              <Badge variant="secondary">New application</Badge>
            )}
            {f.kind === "cpe" && p.application && (
              <span className="text-muted-foreground">
                for {p.application.name}
              </span>
            )}
          </span>
        )
      },
      meta: { label: "What" },
    },
    {
      id: "host",
      accessorFn: (f) =>
        f.host?.name ??
        (f.evidence.length > 1 ? `${f.evidence.length} hosts` : ""),
      header: ({ column }) => <SortHeader column={column} label="Host" />,
      cell: ({ row }) => {
        const f = row.original
        if (f.host)
          return (
            <Host
              device={f.host.kind === "device" ? f.host : null}
              vm={f.host.kind === "virtual_machine" ? f.host : null}
            />
          )
        return (
          <span className="num text-sm whitespace-nowrap">
            {f.evidence.length} {f.evidence.length === 1 ? "port" : "ports"}
          </span>
        )
      },
      meta: { label: "Host" },
    },
    {
      id: "evidence",
      accessorFn: (f) => f.evidence[0]?.banner ?? "",
      header: "Evidence",
      enableSorting: false,
      cell: ({ row }) => {
        const ev = row.original.evidence
        if (ev.length === 0) return dash
        const first = ev[0]
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
            <span className="font-mono whitespace-nowrap">
              {first.address}:{first.port}
            </span>
            <span className="line-clamp-1 font-mono text-muted-foreground">
              {first.banner || first.rule || first.service_name}
            </span>
            <InfoTip>
              <ul className="space-y-1">
                {ev.slice(0, 10).map((e) => (
                  <li key={e.observed_id}>
                    <span className="font-mono text-foreground">
                      {e.address}:{e.port}/{e.protocol}
                    </span>
                    {" · "}
                    {labelOf(SOURCE_LABELS, e.source)}
                    {e.rule ? ` · ${e.rule}` : ""}
                    {e.banner ? (
                      <div className="font-mono break-all">{e.banner}</div>
                    ) : null}
                  </li>
                ))}
                {ev.length > 10 && <li>+{ev.length - 10} more</li>}
              </ul>
            </InfoTip>
          </span>
        )
      },
      meta: { label: "Evidence" },
    },
    {
      id: "confidence",
      accessorKey: "confidence",
      header: ({ column }) => <SortHeader column={column} label="Confidence" />,
      cell: ({ row }) => <ConfidenceBadge value={row.original.confidence} />,
      meta: {
        label: "Confidence",
        facet: confidenceFacet<DiscoveryFinding>(),
      },
    },
  ]
  if (opts.actions) {
    const render = opts.actions
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
