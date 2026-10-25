import { Link } from "@tanstack/react-router"

import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"

import type { AppMapView } from "./model"

/** Nothing to draw: how applications, installs and flows get onto the
 * map - or, filtered, a way back. */
export function AppMapEmpty({
  view,
  filtered,
  onClear,
}: {
  view: AppMapView
  filtered: boolean
  onClear?: () => void
}) {
  if (filtered)
    return (
      <EmptyState title="Nothing on the map matches.">
        {onClear && (
          <Button size="sm" variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </EmptyState>
    )
  return view === "tree" ? (
    <EmptyState title="No applications yet.">
      Add them under{" "}
      <Link to="/applications" className="font-medium hover:underline">
        Applications
      </Link>
      ; a device&rsquo;s or VM&rsquo;s Software tab records their installs.
    </EmptyState>
  ) : (
    <EmptyState title="No flows yet.">
      Record them on an application&rsquo;s Flows tab, from{" "}
      <Link to="/applications" className="font-medium hover:underline">
        Applications
      </Link>
      .
    </EmptyState>
  )
}
