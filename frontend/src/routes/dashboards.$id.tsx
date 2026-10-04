import { createFileRoute } from "@tanstack/react-router"

import { NamedBoard } from "@/components/dashboard/named-board"

interface BoardSearch {
  /** "1": wall-screen mode, no page chrome. */
  tv?: string
  /** Comma-separated dashboard ids to cycle through in TV mode. */
  cycle?: string
  /** Seconds per dashboard when cycling. */
  every?: string
}

export const Route = createFileRoute("/dashboards/$id")({
  component: DashboardPage,
  validateSearch: (s: Record<string, unknown>): BoardSearch => ({
    ...(s.tv === "1" || s.tv === 1 ? { tv: "1" } : {}),
    ...(typeof s.cycle === "string" && s.cycle ? { cycle: s.cycle } : {}),
    ...(s.every != null ? { every: String(s.every) } : {}),
  }),
})

function DashboardPage() {
  const { id } = Route.useParams()
  const s = Route.useSearch()
  const every = Math.max(10, Number(s.every) || 60)
  return (
    <NamedBoard
      key={id}
      id={id}
      tv={s.tv === "1"}
      cycle={s.cycle ? s.cycle.split(",").filter(Boolean) : []}
      every={every}
    />
  )
}
