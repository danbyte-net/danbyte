import { type ReactNode } from "react"

import { QueryError } from "@/components/query-error"

// Facet rail + scrollable table, side by side. Shared by every config panel.
// Owns the panel's loading/error presentation so tables don't pop in with
// zero feedback while the rows query is in flight.
export function FilteredTable({
  rail,
  loading,
  error,
  children,
}: {
  rail: ReactNode
  loading?: boolean
  error?: unknown
  children: ReactNode
}) {
  if (error) {
    return (
      <div className="p-4 lg:p-6">
        <QueryError error={error} />
      </div>
    )
  }
  // While the rows are in flight the facet rail would render half-empty
  // (only its static groups) and then "spawn" the rest — hold it back so
  // rail + table appear together.
  return (
    <div className="flex min-h-0 flex-1">
      {!loading && rail}
      <div className="min-w-0 flex-1 overflow-auto p-4 lg:p-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          children
        )}
      </div>
    </div>
  )
}
