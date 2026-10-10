import { useEffect, useState } from "react"
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react"

import type { FloorPlan, FloorPlanDrawingLayer } from "@/lib/api"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FormCheckbox } from "@/components/forms"
import { Loading } from "@/components/loading"
import { BarIconButton } from "@/components/map-toolbar"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"

import { ROTATIONS, fmtSizeMm, presetHidden, toggleHidden } from "./cad-math"
import type { Rotation } from "./cad-math"
import type { CadDrawingState } from "./use-cad-drawing"

// The drawing's panel over the floor plan: its layers (show/hide, presets,
// text), and for an editor its placement - opacity, rotation, offset - the
// grid fit and the calibration. A viewer's layer choices stay on screen
// only; an editor's save as they are made.

const SCALE_SOURCE: Record<string, string> = {
  units: "From file",
  calibration: "Calibrated",
  assumed: "Assumed mm",
}

/** Above this many layers the list gets a filter box. */
const LAYER_FILTER_AT = 10

export function CadPanel({
  cad,
  plan,
  canEdit,
  onCalibrate,
  onClose,
}: {
  cad: CadDrawingState
  plan: FloorPlan
  canEdit: boolean
  onCalibrate: () => void
  onClose: () => void
}) {
  const d = cad.drawing
  const p = cad.placement
  const [filter, setFilter] = useState("")
  const [opacity, setOpacity] = useState(p.opacity)
  useEffect(() => setOpacity(p.opacity), [p.opacity])
  const [minCell, setMinCell] = useState<number | null>(null)

  const status = d?.status ?? cad.summary?.status
  const hidden = new Set(p.hidden_layers)
  const layers = d?.layers ?? []
  const shown = filter.trim()
    ? layers.filter((l) =>
        l.name.toLowerCase().includes(filter.trim().toLowerCase())
      )
    : layers

  const fit = (cellMm?: number) =>
    cad.fitGrid.mutate(cellMm, {
      onSuccess: (r) => {
        if (!r.ok) setMinCell(r.minCellMm)
        else setMinCell(null)
      },
    })

  return (
    <PanelShell
      label="Drawing"
      title={cad.summary?.source_name || "Drawing"}
      onClose={onClose}
      footer={
        canEdit && status === "ready" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={cad.fitGrid.isPending}
              onClick={() => fit()}
            >
              {cad.fitGrid.isPending ? "Fitting…" : "Fit grid to drawing"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onCalibrate}
            >
              Calibrate
            </Button>
          </>
        ) : undefined
      }
    >
      {!d || status === "queued" ? (
        <Loading className="min-h-20" />
      ) : status === "failed" ? (
        <p className="text-destructive">{d.error || "Processing failed."}</p>
      ) : (
        <>
          <PanelSection label="Layers">
            <div className="mb-2 flex flex-wrap items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() =>
                  cad.change({
                    hidden_layers: presetHidden(layers, "all"),
                    hide_text: false,
                  })
                }
              >
                All
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() =>
                  cad.change({
                    hidden_layers: presetHidden(layers, "architecture"),
                  })
                }
              >
                Architecture only
              </Button>
            </div>
            <FormCheckbox
              label="Hide text"
              checked={p.hide_text}
              onChange={(v) => cad.change({ hide_text: v })}
              className="mb-2"
            />
            {layers.length > LAYER_FILTER_AT && (
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter layers…"
                aria-label="Filter layers"
                className="mb-1 h-7 text-xs"
              />
            )}
            <ul data-part="cad-layers" className="grid gap-0.5">
              {shown.map((l) => (
                <LayerRow
                  key={l.name}
                  layer={l}
                  visible={!hidden.has(l.name)}
                  onToggle={() =>
                    cad.change({
                      hidden_layers: toggleHidden(p.hidden_layers, l.name),
                    })
                  }
                />
              ))}
            </ul>
          </PanelSection>

          {canEdit && (
            <PanelSection label="Placement">
              <div className="grid gap-2">
                <div className="grid gap-1">
                  <span className="text-[11px] text-muted-foreground">
                    Opacity · <span className="num">{opacity}%</span>
                  </span>
                  <Slider
                    min={0}
                    max={100}
                    step={1}
                    value={[opacity]}
                    aria-label="Opacity"
                    onValueChange={([v]) => {
                      setOpacity(v)
                      cad.preview({ opacity: v })
                    }}
                    onValueCommit={([v]) => cad.change({ opacity: v })}
                  />
                </div>
                <div className="grid gap-1">
                  <span className="text-[11px] text-muted-foreground">
                    Rotation
                  </span>
                  <SegmentedTabs
                    value={String(p.rotation)}
                    onValueChange={(v) =>
                      cad.change({ rotation: Number(v) as Rotation })
                    }
                    items={ROTATIONS.map((r) => ({
                      value: String(r),
                      label: `${r}°`,
                    }))}
                  />
                </div>
                <OffsetControls
                  x={p.x_mm}
                  y={p.y_mm}
                  step={plan.cell_mm}
                  onChange={(x, y) => cad.change({ x_mm: x, y_mm: y })}
                />
              </div>
            </PanelSection>
          )}

          <PanelSection label="Scale">
            <PanelRow label="Units">{d.units || "unitless"}</PanelRow>
            <PanelRow label="Scale">
              {SCALE_SOURCE[d.scale_source] ?? d.scale_source}
            </PanelRow>
            <PanelRow label="1 unit">
              <span className="num">{+d.mm_per_unit.toPrecision(4)} mm</span>
            </PanelRow>
            <PanelRow label="Size">
              <span className="num">{fmtSizeMm(d.size_mm)}</span>
            </PanelRow>
            {canEdit && d.calibration && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6 px-2 text-[11px]"
                disabled={cad.resetCalibration.isPending}
                onClick={() => cad.resetCalibration.mutate()}
              >
                {cad.resetCalibration.isPending
                  ? "Resetting…"
                  : "Reset calibration"}
              </Button>
            )}
          </PanelSection>
        </>
      )}

      <ConfirmDialog
        open={minCell != null}
        onOpenChange={(o) => !o && setMinCell(null)}
        title="Use larger cells?"
        description={
          minCell != null
            ? `At ${plan.cell_mm} mm cells the drawing needs more than 512 cells a side. Cells of ${minCell} mm fit it.`
            : undefined
        }
        confirmLabel={minCell != null ? `Use ${minCell} mm` : "Use"}
        pendingLabel="Fitting…"
        destructive={false}
        pending={cad.fitGrid.isPending}
        onConfirm={() => minCell != null && fit(minCell)}
      />
    </PanelShell>
  )
}

function LayerRow({
  layer,
  visible,
  onToggle,
}: {
  layer: FloorPlanDrawingLayer
  visible: boolean
  onToggle: () => void
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted/60">
        <Checkbox
          checked={visible}
          onCheckedChange={onToggle}
          aria-label={layer.name}
        />
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-[3px] border border-border"
          style={{ backgroundColor: layer.color }}
        />
        <span className="min-w-0 flex-1 truncate">{layer.name}</span>
        {layer.frozen ? (
          <Badge variant="secondary" className="h-4 px-1 text-[10px]">
            Frozen
          </Badge>
        ) : !layer.on ? (
          <Badge variant="secondary" className="h-4 px-1 text-[10px]">
            Off
          </Badge>
        ) : null}
        <span className="num shrink-0 text-[11px] text-muted-foreground">
          {layer.entity_count}
        </span>
      </label>
    </li>
  )
}

/** X/Y in mm from the plan's corner, with one-cell nudges. */
function OffsetControls({
  x,
  y,
  step,
  onChange,
}: {
  x: number
  y: number
  step: number
  onChange: (x: number, y: number) => void
}) {
  const [tx, setTx] = useState(String(Math.round(x)))
  const [ty, setTy] = useState(String(Math.round(y)))
  useEffect(() => setTx(String(Math.round(x))), [x])
  useEffect(() => setTy(String(Math.round(y))), [y])
  const commit = () => {
    const nx = Number(tx)
    const ny = Number(ty)
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
    if (nx !== x || ny !== y) onChange(nx, ny)
  }
  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="grid gap-1">
      <span className="text-[11px] whitespace-nowrap text-muted-foreground">
        {label}
      </span>
      <Input
        type="number"
        inputMode="decimal"
        value={value}
        aria-label={label}
        onChange={(e) => set(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
        }}
        className="num h-7 text-xs"
      />
    </label>
  )
  return (
    <div className="grid gap-1">
      <div className="grid grid-cols-2 gap-2">
        {field("Offset X (mm)", tx, setTx)}
        {field("Offset Y (mm)", ty, setTy)}
      </div>
      <div className="flex items-center gap-1">
        <BarIconButton
          label="Move left one cell"
          onClick={() => onChange(x - step, y)}
        >
          <ArrowLeft />
        </BarIconButton>
        <BarIconButton
          label="Move up one cell"
          onClick={() => onChange(x, y - step)}
        >
          <ArrowUp />
        </BarIconButton>
        <BarIconButton
          label="Move down one cell"
          onClick={() => onChange(x, y + step)}
        >
          <ArrowDown />
        </BarIconButton>
        <BarIconButton
          label="Move right one cell"
          onClick={() => onChange(x + step, y)}
        >
          <ArrowRight />
        </BarIconButton>
      </div>
    </div>
  )
}
