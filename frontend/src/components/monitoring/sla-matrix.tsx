import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import type { SlaAnalysis, SlaState } from "@/lib/api"
import { DataTable, SortHeader } from "@/components/data-table"
import { SlaFigureBadge } from "./sla-figure"

type Member = SlaAnalysis["by_member"][number]
type Item = Member["items"][number]

/** The worst of a member's items on one template: a prefix or a device
 * with every address has several. */
function worst(items: Item[]): Item | undefined {
  return items.reduce<Item | undefined>(
    (w, i) =>
      w === undefined || (i.availability ?? 101) < (w.availability ?? 101)
        ? i
        : w,
    undefined
  )
}

/** Members down the side, check templates across the top: each cell the
 * check's availability in the window, against the agreement's target. */
export function MembersMatrix({
  data,
  onMember,
}: {
  data: SlaAnalysis
  onMember: (key: string) => void
}) {
  const target = data.figures.target
  const warning = data.figures.warning

  const templates = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; kind: string }>()
    for (const m of data.by_member)
      for (const i of m.items)
        if (!seen.has(i.template_id))
          seen.set(i.template_id, {
            id: i.template_id,
            name: i.name,
            kind: i.kind,
          })
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [data.by_member])

  const columns = useMemo<ColumnDef<Member, unknown>[]>(() => {
    const state = (av: number | null): SlaState =>
      av == null
        ? "no_data"
        : av < target
          ? "breached"
          : warning != null && av < warning
            ? "at_risk"
            : "ok"
    return [
      {
        id: "member",
        accessorFn: (m) => m.name,
        header: ({ column }) => <SortHeader column={column} label="Member" />,
        cell: ({ row }) => (
          <button
            type="button"
            className="link truncate text-left"
            onClick={() => onMember(row.original.key)}
          >
            {row.original.name}
          </button>
        ),
      },
      ...templates.map<ColumnDef<Member, unknown>>((t) => ({
        id: `t:${t.id}`,
        accessorFn: (m) =>
          worst(m.items.filter((i) => i.template_id === t.id))?.availability ??
          -1,
        header: ({ column }) => (
          <SortHeader
            column={column}
            label={`${t.name} · ${t.kind.toUpperCase()}`}
          />
        ),
        cell: ({ row }) => {
          const mine = row.original.items.filter((i) => i.template_id === t.id)
          const w = worst(mine)
          if (!w) return <span className="text-muted-foreground">-</span>
          const badge = (
            <SlaFigureBadge
              figures={{
                availability: w.availability,
                state: state(w.availability),
                coverage: w.coverage,
              }}
            />
          )
          // One check: straight to it. Several (a prefix): the member panel.
          return mine.length === 1 && w.state_id ? (
            <Link to="/monitoring/checks/$id" params={{ id: w.state_id }}>
              {badge}
            </Link>
          ) : (
            <button type="button" onClick={() => onMember(row.original.key)}>
              {badge}
            </button>
          )
        },
      })),
    ]
  }, [templates, target, warning, onMember])

  if (!templates.length)
    return (
      <p className="text-[13px] text-muted-foreground">No checks measured.</p>
    )
  return (
    <DataTable data={data.by_member} columns={columns} enableExport={false} />
  )
}
