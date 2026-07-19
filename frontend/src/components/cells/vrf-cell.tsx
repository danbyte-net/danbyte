import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { ColorBadge } from "@/components/cells/color-badge"
import { SortHeader } from "@/components/data-table"

// Canonical "render a VRF" + "VRF column" pair. Every list page that
// surfaces a VRF MUST go through here — never inline a chip.
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
}

export function VrfCell({ vrf, linked = true, showRd }: VrfCellProps) {
  if (!vrf) {
    return <span className="text-muted-foreground">Global</span>
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
}

export function vrfColumn<T>(opts: VrfColumnOpts<T>): ColumnDef<T, unknown> {
  const id = opts.id ?? "vrf"
  const header = opts.header ?? "VRF"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "Global",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <VrfCell
        vrf={opts.get(row.original)}
        linked={opts.linked}
        showRd={opts.showRd}
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
            label: vrf?.name ?? "Global",
            color: vrf?.color ?? undefined,
          }
        },
      },
    },
  }
}
