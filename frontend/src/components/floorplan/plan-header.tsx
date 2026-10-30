import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ChevronDown, Plus } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorPlan, FloorPlanStack } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { BarTip } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"

import {
  AddFloorDialog,
  ManageFloorsDialog,
  MergeStacksDialog,
  RenameStackDialog,
} from "./floor-dialogs"
import { FloorSwitcher } from "./floor-switcher"
import type { EditorMode } from "./use-plan-edit-state"

type Open = "add" | "manage" | "merge" | "rename" | null

/** The editor's header: which floor plan, which floor, 2D or 3D, which
 * mode. */
export function PlanHeader({
  plan,
  stack,
  isDirty,
  canEdit,
  canAdd,
  view3d,
  mode,
  onModeChange,
}: {
  plan: FloorPlan
  /** The floor plan this plan is a floor of, with its floors in order. */
  stack: FloorPlanStack | undefined
  isDirty: boolean
  canEdit: boolean
  /** May add floors and floor plans (clone, split). */
  canAdd: boolean
  view3d: boolean
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
}) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState<Open>(null)
  const floors = stack?.floors ?? []
  // Switching floors keeps the 2D/3D choice; the floor itself is the URL.
  const goFloor = (id: string) =>
    nav({
      to: "/floorplans/$id",
      params: { id },
      search: view3d ? { viz: "3d" as const } : {},
    })
  // Clone this floor: a copy with everything drawn on it, as a floor plan
  // of its own.
  const clone = useMutation({
    mutationFn: () =>
      api<FloorPlan>(`/api/floor-plans/${plan.id}/clone/`, { method: "POST" }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ["floor-plan-stacks"] })
      toast.success(`Cloned as ${created.name}`)
      void nav({ to: "/floorplans/$id", params: { id: created.id } })
    },
    onError: (e) => apiErrorToast(e),
  })
  const title = stack?.name ?? plan.stack?.name ?? plan.name
  const menu = canEdit && stack
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
        {menu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="-mx-1 flex max-w-full items-center gap-1 rounded-md px-1 text-left hover:bg-muted/60"
              >
                <h1 className="truncate text-base font-semibold">{title}</h1>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setOpen("manage")}>
                Manage floors…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setOpen("merge")}>
                Merge floor plans…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setOpen("rename")}>
                Rename…
              </DropdownMenuItem>
              {canAdd && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={clone.isPending}
                    onSelect={() => clone.mutate()}
                  >
                    Clone this floor
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <h1 className="truncate text-base font-semibold">{title}</h1>
        )}
        <p className="truncate text-[11px] text-muted-foreground">
          {plan.site.name} · {plan.location.name} ·{" "}
          <span className="num">
            {plan.grid_width}×{plan.grid_height}
          </span>{" "}
          cells
        </p>
      </div>
      {isDirty && <Badge variant="secondary">Edited</Badge>}
      {(floors.length > 1 || (canAdd && stack)) && (
        <div className="ml-4 flex min-w-0 items-center gap-1">
          {floors.length > 1 && (
            // Unsaved edits on a switch are the leave guard's to confirm.
            <FloorSwitcher
              floors={floors}
              value={plan.id}
              onChange={(id) => id !== plan.id && goFloor(id)}
            />
          )}
          {canAdd && stack && (
            <BarTip tip="Add floor">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Add floor"
                onClick={() => setOpen("add")}
              >
                <Plus className="size-3.5" />
              </Button>
            </BarTip>
          )}
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        <SegmentedViz plan={plan} view3d={view3d} />
        {canEdit && !view3d && (
          <ModeTabs mode={mode} onModeChange={onModeChange} />
        )}
      </div>
      {stack && (
        <>
          <AddFloorDialog
            open={open === "add"}
            onOpenChange={(o) => setOpen(o ? "add" : null)}
            stack={stack}
            current={plan}
            onAdded={(p) => goFloor(p.id)}
          />
          <ManageFloorsDialog
            open={open === "manage"}
            onOpenChange={(o) => setOpen(o ? "manage" : null)}
            stack={stack}
            currentId={plan.id}
          />
          <MergeStacksDialog
            open={open === "merge"}
            onOpenChange={(o) => setOpen(o ? "merge" : null)}
            stack={stack}
          />
          <RenameStackDialog
            open={open === "rename"}
            onOpenChange={(o) => setOpen(o ? "rename" : null)}
            stack={stack}
          />
        </>
      )}
    </header>
  )
}

function SegmentedViz({ plan, view3d }: { plan: FloorPlan; view3d: boolean }) {
  const nav = useNavigate()
  return (
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
  )
}

function ModeTabs({
  mode,
  onModeChange,
}: {
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
}) {
  return (
    <SegmentedTabs<EditorMode>
      value={mode}
      onValueChange={onModeChange}
      items={[
        { value: "layout", label: "Layout" },
        { value: "structure", label: "Structure" },
        { value: "cable", label: "Cables" },
      ]}
    />
  )
}
