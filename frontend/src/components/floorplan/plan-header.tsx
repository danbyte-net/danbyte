import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Plus } from "lucide-react"

import type { FloorPlan } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BarTip } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"

import type { EditorMode } from "./use-plan-edit-state"

/** The editor's header: which plan, which floor, 2D or 3D, which mode. */
export function PlanHeader({
  plan,
  floors,
  isDirty,
  canEdit,
  view3d,
  mode,
  onModeChange,
}: {
  plan: FloorPlan
  /** The plans of the same location - the floors of this building. */
  floors: FloorPlan[] | undefined
  isDirty: boolean
  canEdit: boolean
  view3d: boolean
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
}) {
  const nav = useNavigate()
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
      <BarTip tip="Floor plans">
        <Button variant="ghost" size="icon-sm" asChild className="-ml-2">
          <Link to="/floorplans" aria-label="Floor plans">
            <ArrowLeft />
          </Link>
        </Button>
      </BarTip>
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">{plan.name}</h1>
        <p className="truncate text-[11px] text-muted-foreground">
          {plan.site.name} · {plan.location.name} ·{" "}
          <span className="num">
            {plan.grid_width}×{plan.grid_height}
          </span>{" "}
          cells
        </p>
      </div>
      {isDirty && <Badge variant="secondary">Edited</Badge>}
      {(floors?.length ?? 0) > 0 && (
        <div className="ml-4 flex min-w-0 items-center gap-1">
          <SegmentedTabs
            value={plan.id}
            onValueChange={(pid) => {
              if (pid === plan.id) return
              // Just navigate. Switching floors re-mounts the editor and drops
              // unsaved edits, but that is the leave guard's call to make -
              // confirming here too would stack a second dialog on the same
              // click.
              nav({ to: "/floorplans/$id", params: { id: pid } })
            }}
            items={(floors ?? []).map((p) => ({
              value: p.id,
              label: p.name,
            }))}
          />
          {canEdit && (
            <BarTip tip="Add floor">
              <Button variant="ghost" size="icon-sm" asChild>
                <Link
                  to="/floorplans/new"
                  search={{ location: plan.location.id }}
                  aria-label="Add floor"
                >
                  <Plus className="size-3.5" />
                </Link>
              </Button>
            </BarTip>
          )}
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        <SegmentedTabs<"2d" | "3d">
          value={view3d ? "3d" : "2d"}
          onValueChange={(v) =>
            nav({
              to: "/floorplans/$id",
              params: { id: plan.id },
              search: (prev) => ({
                ...prev,
                viz: v === "3d" ? ("3d" as const) : undefined,
              }),
              replace: true,
            })
          }
          items={[
            { value: "2d", label: "2D" },
            { value: "3d", label: "3D" },
          ]}
        />
        {canEdit && !view3d && (
          <SegmentedTabs<EditorMode>
            value={mode}
            onValueChange={onModeChange}
            items={[
              { value: "layout", label: "Layout" },
              { value: "structure", label: "Structure" },
              { value: "cable", label: "Cables" },
            ]}
          />
        )}
      </div>
    </header>
  )
}
