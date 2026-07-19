import { useEffect, useState } from "react"

import type { SiteMapFov } from "@/lib/api"
import { Slider } from "@/components/ui/slider"

// The map's FOV editor — a direct port of the floorplan TileInspector's
// cone block (PTZ toggle + Direction / Angle / Reach sliders), with reach in
// meters. Drags feed `onDraft` for live cone preview; releasing a slider
// (onValueCommit) or toggling PTZ calls `onCommit` to persist.

const DEFAULTS: SiteMapFov = {
  direction: 0,
  deg: 90,
  distance_m: 50,
  ptz: false,
}

export function FovEditor({
  value,
  onDraft,
  onCommit,
}: {
  value: SiteMapFov | null
  onDraft: (v: SiteMapFov | null) => void
  onCommit: (v: SiteMapFov | null) => void
}) {
  const [draft, setDraft] = useState<SiteMapFov | null>(value)
  useEffect(() => setDraft(value), [value])

  const set = (patch: Partial<SiteMapFov>, commit: boolean) => {
    const next = { ...(draft ?? DEFAULTS), ...patch }
    setDraft(next)
    onDraft(next)
    if (commit) onCommit(next)
  }

  if (!draft) {
    return (
      <button
        className="w-fit rounded-md border border-dashed border-border px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted"
        onClick={() => {
          setDraft(DEFAULTS)
          onDraft(DEFAULTS)
          onCommit(DEFAULTS)
        }}
      >
        + Add coverage cone
      </button>
    )
  }

  return (
    <div className="grid gap-2 rounded-md border border-border p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          Field of view
        </span>
        <button
          className="text-[11px] text-destructive hover:underline"
          onClick={() => {
            setDraft(null)
            onDraft(null)
            onCommit(null)
          }}
        >
          Remove
        </button>
      </div>
      <label className="flex items-center gap-1.5 text-[12px]">
        <input
          type="checkbox"
          className="ck"
          checked={draft.ptz}
          onChange={(e) => set({ ptz: e.target.checked }, true)}
        />
        PTZ (360° coverage ring)
      </label>
      {!draft.ptz && (
        <>
          <FovSlider
            label="Direction"
            value={draft.direction ?? 0}
            min={0}
            max={359}
            step={1}
            unit="°"
            onDraft={(v) => set({ direction: v }, false)}
            onCommit={(v) => set({ direction: v }, true)}
          />
          <FovSlider
            label="Angle"
            value={draft.deg ?? 90}
            min={10}
            max={360}
            step={5}
            unit="°"
            onDraft={(v) => set({ deg: v }, false)}
            onCommit={(v) => set({ deg: v }, true)}
          />
        </>
      )}
      <FovSlider
        label="Reach"
        value={draft.distance_m ?? 50}
        min={5}
        max={500}
        step={5}
        unit=" m"
        onDraft={(v) => set({ distance_m: v }, false)}
        onCommit={(v) => set({ distance_m: v }, true)}
      />
    </div>
  )
}

function FovSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onDraft,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onDraft: (v: number) => void
  onCommit: (v: number) => void
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="num">
          {value}
          {unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(v) => onDraft(v[0])}
        onValueCommit={(v) => onCommit(v[0])}
      />
    </div>
  )
}
