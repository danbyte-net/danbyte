import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RotateCcw,
  RotateCw,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorPlanFloor, FloorPlanStack } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Field } from "@/components/forms"
import { Loading } from "@/components/loading"
import { BarIconButton } from "@/components/map-toolbar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useScene } from "@/components/floorplan3d/use-scene"
import type { ScenePayload } from "@/components/floorplan3d/world"

import { gridOf, levelAlign, levelToFrameMm, neighbours } from "./levels"
import type { LevelAlign } from "./levels"

type Pt = [number, number]

/** A level's walls and grid outline in the stack's frame (mm). */
function framed(
  scene: ScenePayload | undefined,
  floor: FloorPlanFloor,
  a: LevelAlign
): { walls: Pt[][]; outline: Pt[] } {
  const grid = gridOf(floor)
  const map = (p: Pt) => levelToFrameMm(p, grid, a)
  const w = grid.grid_width
  const h = grid.grid_height
  return {
    walls: (scene?.walls ?? [])
      .filter((x) => x.points.length >= 2)
      .map((x) => x.points.map(map)),
    outline: (
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ] as Pt[]
    ).map(map),
  }
}

const d = (pts: Pt[], close = false) =>
  pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ") +
  (close ? " Z" : "")

const round3 = (v: number) => Math.round(v * 1000) / 1000

/** Align floors…: nudge and turn one level over another (its onion skin)
 * until the walls line up; saved as the level's offset. Turning the floor
 * plan's alignment on happens here too. */
export function AlignFloorsDialog({
  open,
  onOpenChange,
  stack,
  currentId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stack: FloorPlanStack
  currentId: string
}) {
  const qc = useQueryClient()
  const levels = stack.floors.filter((f) => f.kind !== "view")
  const [movingId, setMovingId] = useState(currentId)
  const [againstId, setAgainstId] = useState("")
  const [align, setAlign] = useState<LevelAlign>({ dx: 0, dy: 0, rot: 0 })
  const [step, setStep] = useState("0.5")
  const [aligned, setAligned] = useState(true)
  const moving = levels.find((f) => f.id === movingId) ?? null
  const against = levels.find((f) => f.id === againstId) ?? null
  useEffect(() => {
    if (!open) return
    const start =
      levels.find((f) => f.id === currentId) ??
      (levels.length ? levels[0] : null)
    if (!start) return
    setMovingId(start.id)
    setAligned(true)
  }, [open])
  useEffect(() => {
    if (!moving) return
    setAlign(levelAlign(moving))
    const nb = neighbours(levels, moving.id)
    setAgainstId((nb.below ?? nb.above)?.id ?? "")
  }, [movingId, open])
  const movingScene = useScene(moving?.id ?? "", { enabled: open && !!moving })
  const againstScene = useScene(against?.id ?? "", {
    enabled: open && !!against,
  })
  const top = useMemo(
    () => (moving ? framed(movingScene.data, moving, align) : null),
    [movingScene.data, moving, align]
  )
  const base = useMemo(
    () =>
      against ? framed(againstScene.data, against, levelAlign(against)) : null,
    [againstScene.data, against]
  )
  const view = useMemo(() => {
    const pts = [
      ...(top?.outline ?? []),
      ...(base?.outline ?? []),
      ...(top?.walls.flat() ?? []),
      ...(base?.walls.flat() ?? []),
    ]
    if (!pts.length) return "0 0 1000 1000"
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x0 = Math.min(...xs)
    const y0 = Math.min(...ys)
    const w = Math.max(...xs) - x0 || 1000
    const h = Math.max(...ys) - y0 || 1000
    const pad = Math.max(w, h) * 0.05
    return `${x0 - pad} ${y0 - pad} ${w + 2 * pad} ${h + 2 * pad}`
  }, [top, base])
  const stroke = Math.max(40, (Number(view.split(" ")[2]) || 1000) / 250)

  const nudge = (dx: number, dy: number) =>
    setAlign((a) => ({
      ...a,
      dx: round3(a.dx + dx * Number(step)),
      dy: round3(a.dy + dy * Number(step)),
    }))
  const turn = (deg: number) =>
    setAlign((a) => {
      let rot = round3(a.rot + deg)
      if (rot > 180) rot -= 360
      if (rot <= -180) rot += 360
      return { ...a, rot }
    })
  // Arrow keys nudge, [ and ] turn - while the dialog is up and no field
  // has the focus.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest("input, textarea, [role=combobox]")) return
      const map: Record<string, () => void> = {
        ArrowLeft: () => nudge(-1, 0),
        ArrowRight: () => nudge(1, 0),
        ArrowUp: () => nudge(0, -1),
        ArrowDown: () => nudge(0, 1),
        "[": () => turn(-1),
        "]": () => turn(1),
      }
      if (!(e.key in map)) return
      e.preventDefault()
      map[e.key]()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const save = useMutation({
    mutationFn: async () => {
      if (!moving) return
      await api(`/api/floor-plans/${moving.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          align_dx: align.dx,
          align_dy: align.dy,
          align_rot: align.rot,
        }),
      })
      if (!!stack.aligned !== aligned)
        await api(`/api/floor-plan-stacks/${stack.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ aligned }),
        })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["floor-plan-stack"] })
      void qc.invalidateQueries({ queryKey: ["floor-plan-stacks"] })
      void qc.invalidateQueries({ queryKey: ["floor-plan"] })
      toast.success(`Aligned ${moving?.name ?? ""}`)
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  const field = (key: keyof LevelAlign, label: string) => (
    <Field label={label}>
      <Input
        type="number"
        step={key === "rot" ? 1 : 0.1}
        value={align[key]}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) setAlign((a) => ({ ...a, [key]: v }))
        }}
        className="num h-8"
        aria-label={label}
      />
    </Field>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Align floors</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
          <div className="relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-muted/30">
            {movingScene.isLoading || againstScene.isLoading ? (
              <Loading />
            ) : (
              <svg
                viewBox={view}
                className="h-full w-full"
                aria-label="Alignment preview"
              >
                {base && (
                  <g
                    className="stroke-muted-foreground"
                    fill="none"
                    opacity={0.6}
                  >
                    <path
                      d={d(base.outline, true)}
                      strokeWidth={stroke / 2}
                      strokeDasharray={`${stroke * 2} ${stroke * 2}`}
                    />
                    {base.walls.map((w, i) => (
                      <path key={i} d={d(w)} strokeWidth={stroke * 1.6} />
                    ))}
                  </g>
                )}
                {top && (
                  <g className="stroke-primary" fill="none">
                    <path
                      d={d(top.outline, true)}
                      strokeWidth={stroke / 2}
                      strokeDasharray={`${stroke * 2} ${stroke * 2}`}
                    />
                    {top.walls.map((w, i) => (
                      <path key={i} d={d(w)} strokeWidth={stroke} />
                    ))}
                  </g>
                )}
              </svg>
            )}
          </div>
          <div className="grid content-start gap-3">
            <Field label="Level">
              <Select value={movingId} onValueChange={setMovingId}>
                <SelectTrigger className="h-8 w-full" aria-label="Level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {levels.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Over">
              <Select value={againstId} onValueChange={setAgainstId}>
                <SelectTrigger className="h-8 w-full" aria-label="Over">
                  <SelectValue placeholder="Pick a level" />
                </SelectTrigger>
                <SelectContent>
                  {levels
                    .filter((f) => f.id !== movingId)
                    .map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-center gap-1">
              <div className="grid grid-cols-3 gap-1">
                <span />
                <BarIconButton label="Up" onClick={() => nudge(0, -1)}>
                  <ArrowUp />
                </BarIconButton>
                <span />
                <BarIconButton label="Left" onClick={() => nudge(-1, 0)}>
                  <ArrowLeft />
                </BarIconButton>
                <span />
                <BarIconButton label="Right" onClick={() => nudge(1, 0)}>
                  <ArrowRight />
                </BarIconButton>
                <span />
                <BarIconButton label="Down" onClick={() => nudge(0, 1)}>
                  <ArrowDown />
                </BarIconButton>
                <span />
              </div>
              <div className="ml-auto grid gap-1">
                <BarIconButton label="Turn left 1°" onClick={() => turn(-1)}>
                  <RotateCcw />
                </BarIconButton>
                <BarIconButton label="Turn right 1°" onClick={() => turn(1)}>
                  <RotateCw />
                </BarIconButton>
              </div>
            </div>
            <Field label="Step">
              <Select value={step} onValueChange={setStep}>
                <SelectTrigger className="h-8 w-full" aria-label="Step">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.1">0.1 cell</SelectItem>
                  <SelectItem value="0.5">0.5 cell</SelectItem>
                  <SelectItem value="1">1 cell</SelectItem>
                  <SelectItem value="5">5 cells</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              {field("dx", "X")}
              {field("dy", "Y")}
              {field("rot", "Turn °")}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={aligned}
                onCheckedChange={(v) => setAligned(v === true)}
              />
              <span className="whitespace-nowrap">Aligned floors</span>
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!moving || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
