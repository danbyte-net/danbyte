import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { ColorBadge } from "@/components/cells/color-badge"
import { SortHeader } from "@/components/data-table"

// Canonical "render a VRF" + "VRF column" pair. Every list page that
// surfaces a VRF MUST go through here - never inline a chip.
//
// Anatomy:
//   <VrfCell vrf={...} linked />       single inline render
//   vrfColumn<MyRow>({ get: r => r.vrf })   drop into ColumnDef[]

export interface VrfLike {
  id: string
  name: string
  color?: string | null
  rd?: string | null
}

export interface VrfCellProps {
  vrf: VrfLike | null | undefined
  /** Wrap the badge in a /vrfs/$id link. Default true (matches list-page UX). */
  linked?: boolean
  /** Render the muted RD suffix inside the badge. Default false. */
  showRd?: boolean
  /** Shown when there is no VRF; "Global" unless told otherwise. */
  noneLabel?: string
}

export function VrfCell({
  vrf,
  linked = true,
  showRd,
  noneLabel = "Global",
}: VrfCellProps) {
  if (!vrf) {
    return <span className="text-muted-foreground">{noneLabel}</span>
  }
  const badge = (
    <ColorBadge
      name={vrf.name}
      color={vrf.color || undefined}
      suffix={showRd && vrf.rd ? vrf.rd : undefined}
    />
  )
  if (linked) {
    return (
      <Link to="/vrfs/$id" params={{ id: vrf.id }} className="hover:opacity-90">
        {badge}
      </Link>
    )
  }
  return badge
}

export interface VrfColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => VrfLike | null | undefined
  linked?: boolean
  showRd?: boolean
  /** What an empty value means: "Global" for addresses and prefixes (the
   *  default), "-" for a VLAN that simply has no VRF recorded. */
  noneLabel?: string
}

export function vrfColumn<T>(opts: VrfColumnOpts<T>): ColumnDef<T, unknown> {
  const id = opts.id ?? "vrf"
  const header = opts.header ?? "VRF"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? opts.noneLabel ?? "Global",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <VrfCell
        vrf={opts.get(row.original)}
        linked={opts.linked}
        showRd={opts.showRd}
        noneLabel={opts.noneLabel}
      />
    ),
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__global__",
        formatValue: (_v, sample) => {
          const vrf = opts.get(sample)
          return {
            label: vrf?.name ?? opts.noneLabel ?? "Global",
            color: vrf?.color ?? undefined,
          }
        },
      },
    },
  }
}
