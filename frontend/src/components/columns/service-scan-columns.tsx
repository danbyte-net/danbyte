import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  DiscoveryFinding,
  FindingEvidence,
  FindingKind,
  ObservedService,
  ServiceConfidence,
} from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"
import { TruncatedText } from "@/components/ui/truncated-text"

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

function proposalText(f: DiscoveryFinding): string {
  const p = f.proposal
  if (f.kind === "service") return p.name ?? ""
  if (f.kind === "software")
    return [p.application?.name ?? p.application_name, p.version]
      .filter(Boolean)
      .join(" ")
  return p.identifier ?? ""
}

function evidenceText(e: FindingEvidence): string {
  return e.banner || e.rule || e.service_name || ""
}

/** The review queue, read left to right: where, which port, what is
 * proposed, how sure, from what, the evidence (the elastic column), when.
 * Actions stay pinned at the right edge. */
export function buildFindingColumns(
  opts: { actions?: (f: DiscoveryFinding) => React.ReactNode } = {}
): ColumnDef<DiscoveryFinding, unknown>[] {
  const cols: ColumnDef<DiscoveryFinding, unknown>[] = [
    selectionColumn<DiscoveryFinding>(),
    {
      id: "host",
      accessorFn: (f) => f.host?.name ?? f.evidence.at(0)?.address ?? "",
      header: ({ column }) => <SortHeader column={column} label="Host" />,
      cell: ({ row }) => {
        const f = row.original
        const first = f.evidence.at(0)
        return (
          <span className="flex max-w-[8rem] flex-col text-xs leading-tight whitespace-nowrap">
            {f.host ? (
              <TruncatedText title={f.host.name}>
                <Host
                  device={f.host.kind === "device" ? f.host : null}
                  vm={f.host.kind === "virtual_machine" ? f.host : null}
                />
              </TruncatedText>
            ) : f.evidence.length > 1 ? (
              <span className="num">{f.evidence.length} hosts</span>
            ) : null}
            {first && (f.host || f.evidence.length === 1) && (
              <span className="font-mono text-muted-foreground">
                {first.address}
              </span>
            )}
          </span>
        )
      },
      meta: { label: "Host" },
    },
    {
      id: "port",
      accessorFn: (f) => f.proposal.port ?? f.evidence.at(0)?.port ?? 0,
      header: ({ column }) => <SortHeader column={column} label="Port" />,
      cell: ({ row }) => {
        const f = row.original
        const port = f.proposal.port ?? f.evidence.at(0)?.port
        const protocol = f.proposal.protocol ?? f.evidence.at(0)?.protocol
        if (port == null) return dash
        const others = new Set(f.evidence.map((e) => e.port)).size - 1
        return (
          <span className="num font-mono text-xs whitespace-nowrap">
            {protocol}/{port}
            {others > 0 && (
              <span className="text-muted-foreground"> +{others}</span>
            )}
          </span>
        )
      },
      meta: { label: "Port" },
    },
    {
      id: "kind",
      accessorFn: (f) => `${f.kind} ${proposalText(f)}`,
      header: ({ column }) => <SortHeader column={column} label="Proposal" />,
      cell: ({ row }) => {
        const f = row.original
        const p = f.proposal
        const what =
          f.kind === "cpe" && p.application
            ? `${proposalText(f)} for ${p.application.name}`
            : proposalText(f)
        return (
          <span className="flex max-w-[10rem] flex-col leading-tight">
            <TruncatedText
              className={f.kind === "cpe" ? "font-mono text-xs" : "text-sm"}
            >
              {what}
            </TruncatedText>
            <span className="flex min-w-0 items-center gap-1">
              <TruncatedText className="text-xs text-muted-foreground">
                {labelOf(FINDING_KIND_LABELS, f.kind) +
                  (f.kind === "software" && !p.application
                    ? " · new application"
                    : "")}
              </TruncatedText>
              {f.ignored && <Badge variant="secondary">Ignored</Badge>}
            </span>
          </span>
        )
      },
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
      id: "confidence",
      accessorKey: "confidence",
      header: ({ column }) => <SortHeader column={column} label="Confidence" />,
      cell: ({ row }) => <ConfidenceBadge value={row.original.confidence} />,
      meta: {
        label: "Confidence",
        facet: confidenceFacet<DiscoveryFinding>(),
      },
    },
    {
      id: "source",
      accessorFn: (f) => f.evidence.at(0)?.source ?? "",
      header: "Source",
      enableSorting: false,
      cell: ({ row }) => {
        const src = row.original.evidence.at(0)?.source
        return src ? (
          <span className="text-xs whitespace-nowrap">
            {labelOf(SOURCE_LABELS, src)}
          </span>
        ) : (
          dash
        )
      },
      meta: {
        label: "Source",
        facet: {
          kind: "enum",
          label: "Source",
          get: (f: DiscoveryFinding) => f.evidence.at(0)?.source ?? "",
          formatValue: (v) => ({ label: labelOf(SOURCE_LABELS, v) }),
        },
      },
    },
    {
      id: "evidence",
      accessorFn: (f) => {
        const first = f.evidence.at(0)
        return first ? evidenceText(first) : ""
      },
      header: "Evidence",
      enableSorting: false,
      cell: ({ row }) => {
        const ev = row.original.evidence
        if (ev.length === 0) return dash
        const full = ev
          .slice(0, 10)
          .map(
            (e) =>
              `${e.address}:${e.port}/${e.protocol} · ${labelOf(SOURCE_LABELS, e.source)}` +
              (e.rule ? ` · ${e.rule}` : "") +
              (e.banner ? ` · ${e.banner}` : "")
          )
          .concat(ev.length > 10 ? [`+${ev.length - 10} more`] : [])
          .join("; ")
        // Zero intrinsic width: the column takes what the others leave and
        // the text truncates inside it, the full evidence on hover.
        return (
          <span className="block w-0 min-w-full">
            <TruncatedText
              className="block font-mono text-xs text-muted-foreground"
              title={full}
            >
              {evidenceText(ev[0]) || `${ev[0].address}:${ev[0].port}`}
            </TruncatedText>
          </span>
        )
      },
      meta: { label: "Evidence" },
    },
    {
      id: "last_seen",
      accessorFn: (f) =>
        f.evidence.reduce((m, e) => (e.last_seen > m ? e.last_seen : m), ""),
      header: ({ column }) => <SortHeader column={column} label="Last seen" />,
      cell: ({ row }) => {
        const last = row.original.evidence.reduce(
          (m, e) => (e.last_seen > m ? e.last_seen : m),
          ""
        )
        return last ? <TimeCell iso={last} /> : dash
      },
      meta: { label: "Last seen" },
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
