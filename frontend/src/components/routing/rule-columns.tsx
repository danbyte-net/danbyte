import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  ASPathListRule,
  CommunityListRule,
  PrefixListRule,
  RoutingPolicyRule,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { dash } from "@/components/cells/dash"

// Read-only rule rows on the detail pages - the lines the box would print,
// one per rule, permit/deny as a badge, everything else monospace.

function seq<T extends { sequence: number }>(): ColumnDef<T, unknown> {
  return {
    id: "sequence",
    accessorKey: "sequence",
    header: "Seq",
    cell: ({ row }) => (
      <span className="num font-mono text-xs">{row.original.sequence}</span>
    ),
  }
}

function action<T extends { action: "permit" | "deny" }>(): ColumnDef<
  T,
  unknown
> {
  return {
    id: "action",
    accessorKey: "action",
    header: "Action",
    cell: ({ row }) => (
      <Badge
        variant={row.original.action === "permit" ? "success" : "destructive"}
      >
        {row.original.action}
      </Badge>
    ),
  }
}

function description<T extends { description: string }>(): ColumnDef<
  T,
  unknown
> {
  return {
    id: "description",
    accessorKey: "description",
    header: "Description",
    cell: ({ row }) => (
      <span className="line-clamp-1 block text-muted-foreground">
        {row.original.description || "-"}
      </span>
    ),
  }
}

export function prefixListRuleColumns(): ColumnDef<PrefixListRule, unknown>[] {
  return [
    seq(),
    action(),
    {
      id: "prefix",
      accessorKey: "prefix",
      header: "Prefix",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.prefix_obj ? (
            <Link
              to="/prefixes/$id"
              params={{ id: row.original.prefix_obj.id }}
              className="link"
            >
              {row.original.prefix}
            </Link>
          ) : (
            row.original.prefix
          )}
        </span>
      ),
    },
    {
      id: "ge",
      accessorKey: "ge",
      header: "ge",
      cell: ({ row }) =>
        row.original.ge != null ? (
          <span className="num font-mono text-xs">{row.original.ge}</span>
        ) : (
          dash
        ),
    },
    {
      id: "le",
      accessorKey: "le",
      header: "le",
      cell: ({ row }) =>
        row.original.le != null ? (
          <span className="num font-mono text-xs">{row.original.le}</span>
        ) : (
          dash
        ),
    },
    description(),
  ]
}

export function communityListRuleColumns(): ColumnDef<
  CommunityListRule,
  unknown
>[] {
  return [
    seq(),
    action(),
    {
      id: "match",
      header: "Matches",
      cell: ({ row }) =>
        row.original.regex ? (
          <span className="font-mono text-xs">{row.original.regex}</span>
        ) : row.original.communities.length ? (
          <span className="flex flex-wrap gap-1">
            {row.original.communities.map((c) => (
              <Link key={c.id} to="/communities/$id" params={{ id: c.id }}>
                <Badge variant="secondary" className="font-mono">
                  {c.value}
                </Badge>
              </Link>
            ))}
          </span>
        ) : (
          dash
        ),
    },
    description(),
  ]
}

export function asPathListRuleColumns(): ColumnDef<ASPathListRule, unknown>[] {
  return [
    seq(),
    action(),
    {
      id: "regex",
      accessorKey: "regex",
      header: "Pattern",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.regex}</span>
      ),
    },
    description(),
  ]
}

function names(rows: { id: string; name: string }[], to: string) {
  if (!rows.length) return null
  return rows.map((r) => (
    <Link
      key={r.id}
      to={to}
      params={{ id: r.id }}
      className="link font-mono text-xs"
    >
      {r.name}
    </Link>
  ))
}

export function policyRuleColumns(): ColumnDef<RoutingPolicyRule, unknown>[] {
  return [
    seq(),
    action(),
    {
      id: "match",
      header: "Match",
      cell: ({ row }) => {
        const r = row.original
        const parts: React.ReactNode[] = []
        const pl = names(r.match_prefix_lists, "/prefix-lists/$id")
        const cl = names(r.match_community_lists, "/community-lists/$id")
        const al = names(r.match_as_path_lists, "/as-path-lists/$id")
        if (pl) parts.push(<span key="pl">prefix-list {pl}</span>)
        if (cl) parts.push(<span key="cl">community {cl}</span>)
        if (al) parts.push(<span key="al">as-path {al}</span>)
        if (r.match_next_hop)
          parts.push(
            <span key="nh">
              next-hop{" "}
              <Link
                to="/prefix-lists/$id"
                params={{ id: r.match_next_hop.id }}
                className="link font-mono text-xs"
              >
                {r.match_next_hop.name}
              </Link>
            </span>
          )
        for (const [k, v] of Object.entries(r.match_extra))
          parts.push(
            <span key={k} className="font-mono">
              {k} {String(v)}
            </span>
          )
        return parts.length ? (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {parts}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">any</span>
        )
      },
    },
    {
      id: "set",
      header: "Set",
      cell: ({ row }) => {
        const r = row.original
        const parts: string[] = []
        if (r.set_local_pref != null)
          parts.push(`local-preference ${r.set_local_pref}`)
        if (r.set_med != null) parts.push(`metric ${r.set_med}`)
        if (r.set_weight != null) parts.push(`weight ${r.set_weight}`)
        if (r.set_origin) parts.push(`origin ${r.set_origin}`)
        if (r.set_next_hop) parts.push(`ip next-hop ${r.set_next_hop}`)
        if (r.set_as_path_prepend)
          parts.push(`as-path prepend ${r.set_as_path_prepend}`)
        if (r.set_communities.length)
          parts.push(
            `community ${r.set_communities.map((c) => c.value).join(" ")}${
              r.set_communities_additive ? " additive" : ""
            }`
          )
        if (r.set_metric_type != null)
          parts.push(`metric-type type-${r.set_metric_type}`)
        for (const [k, v] of Object.entries(r.set_extra))
          parts.push(`${k} ${String(v)}`)
        if (r.continue_seq != null) parts.push(`continue ${r.continue_seq}`)
        return parts.length ? (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
            {parts.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </span>
        ) : (
          dash
        )
      },
    },
    description(),
  ]
}
