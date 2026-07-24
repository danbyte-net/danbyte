import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DeviceType,
  type DeviceTypeWritePayload,
  type ImagePortMarker,
  type ImagePorts,
  type Paginated,
} from "@/lib/api"
import type { PortComponent, SlotKind } from "@/lib/faceplate-layout"
import {
  TEMPLATE_ENDPOINT,
  TEMPLATE_QUERY_KEY,
} from "@/components/component-template-dialog"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/forms"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { cn } from "@/lib/utils"

// Placeable kinds — the port-ish component templates (no bays/inventory).
const KINDS: SlotKind[] = [
  "interface",
  "console-port",
  "console-server-port",
  "power-port",
  "power-outlet",
  "front-port",
  "rear-port",
  "aux-port",
]
const KIND_LABEL: Record<SlotKind, string> = {
  interface: "Interfaces",
  "console-port": "Console",
  "console-server-port": "Console server",
  "power-port": "Power ports",
  "power-outlet": "Power outlets",
  "front-port": "Front ports",
  "rear-port": "Rear ports",
  "aux-port": "Aux ports",
}

const DEFAULT_W = 0.03
const DEFAULT_H = 0.35
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const markerKey = (m: { kind: string; name: string }) => `${m.kind}:${m.name}`

type Side = "front" | "rear"

/**
 * "Photo ports" builder — drop interface/port templates onto the device type's
 * real front/rear photo and position them precisely (drag, resize handle,
 * arrow-nudge, numeric inputs, optional fine-grid snap). Saves
 * `DeviceType.image_ports` (normalized 0..1 coords), which the 2D image
 * faceplate and the 3D device face then render, live-lit.
 */
export function DeviceTypeImagePortsPane({
  deviceType,
}: {
  deviceType: DeviceType
}) {
  const { canDo } = useMe()
  const canWrite = canDo("devicetype", "change")
  const qc = useQueryClient()

  const templateQueries = useQueries({
    queries: KINDS.map((k) => ({
      queryKey: [TEMPLATE_QUERY_KEY[k], deviceType.id],
      queryFn: () =>
        api<Paginated<PortComponent>>(
          `/api/${TEMPLATE_ENDPOINT[k]}/?device_type=${deviceType.id}`
        ),
    })),
  })
  const templatesByKind = useMemo(() => {
    const out: Partial<Record<SlotKind, PortComponent[]>> = {}
    KINDS.forEach((k, i) => {
      out[k] = templateQueries[i]?.data?.results ?? []
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...templateQueries.map((q) => q.data)])

  const [side, setSide] = useState<Side>("front")
  const [ports, setPorts] = useState<ImagePorts>(
    () => deviceType.image_ports ?? { front: [], rear: [] }
  )
  const [dirty, setDirty] = useState(false)
  const [sel, setSel] = useState<number | null>(null)
  const [snap, setSnap] = useState(true)
  const imgRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{
    mode: "move" | "resize"
    i: number
    startX: number
    startY: number
    orig: ImagePortMarker
  } | null>(null)

  useEffect(() => {
    if (!dirty) setPorts(deviceType.image_ports ?? { front: [], rear: [] })
  }, [deviceType.image_ports, dirty])

  const image = side === "front" ? deviceType.front_image : deviceType.rear_image
  const markers = ports[side]
  const update = (next: ImagePorts) => {
    setPorts(next)
    setDirty(true)
  }
  const setMarkers = (ms: ImagePortMarker[]) =>
    update({ ...ports, [side]: ms })

  // Placed keys (both sides) so the palette hides what's already down.
  const placed = useMemo(() => {
    const s = new Set<string>()
    for (const sd of ["front", "rear"] as const)
      for (const m of ports[sd]) s.add(markerKey(m))
    return s
  }, [ports])

  const snapV = (v: number) => (snap ? Math.round(v * 200) / 200 : v)

  const patchSel = (patch: Partial<ImagePortMarker>) => {
    if (sel == null) return
    setMarkers(markers.map((m, i) => (i === sel ? { ...m, ...patch } : m)))
  }

  // ── Pointer drag / resize on the image ──────────────────────────────────
  const onPointerDownMarker = (
    e: React.PointerEvent,
    i: number,
    mode: "move" | "resize"
  ) => {
    if (!canWrite) return
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setSel(i)
    drag.current = {
      mode,
      i,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...markers[i] },
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const box = imgRef.current?.getBoundingClientRect()
    if (!d || !box) return
    const dx = (e.clientX - d.startX) / box.width
    const dy = (e.clientY - d.startY) / box.height
    if (d.mode === "move") {
      patchAt(d.i, {
        x: clamp01(snapV(d.orig.x + dx)),
        y: clamp01(snapV(d.orig.y + dy)),
      })
    } else {
      patchAt(d.i, {
        w: clamp01(snapV(Math.max(0.008, d.orig.w + dx * 2))),
        h: clamp01(snapV(Math.max(0.02, d.orig.h + dy * 2))),
      })
    }
  }
  const patchAt = (i: number, patch: Partial<ImagePortMarker>) =>
    setMarkers(markers.map((m, k) => (k === i ? { ...m, ...patch } : m)))
  const endDrag = () => {
    drag.current = null
  }

  // Drop a palette template onto the image at the cursor.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData("text/plain")
    const box = imgRef.current?.getBoundingClientRect()
    if (!raw || !box) return
    const sep = raw.indexOf(":")
    if (sep < 0) return
    const kind = raw.slice(0, sep)
    const name = raw.slice(sep + 1)
    const x = clamp01(snapV((e.clientX - box.left) / box.width))
    const y = clamp01(snapV((e.clientY - box.top) / box.height))
    setMarkers([
      ...markers,
      { kind, name, x, y, w: DEFAULT_W, h: DEFAULT_H },
    ])
    setSel(markers.length)
  }

  // Arrow-key nudge for the selected marker (Shift = coarse).
  useEffect(() => {
    if (sel == null || !canWrite) return
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 0.01 : 0.002
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step],
      }
      if (e.key in d) {
        e.preventDefault()
        const [dx, dy] = d[e.key]
        setMarkers(
          markers.map((m, i) =>
            i === sel
              ? { ...m, x: clamp01(m.x + dx), y: clamp01(m.y + dy) }
              : m
          )
        )
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        setMarkers(markers.filter((_, i) => i !== sel))
        setSel(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, markers, canWrite])

  const save = useMutation({
    mutationFn: () => {
      // Drop a side entirely when empty so we store a tidy doc / null.
      const body: ImagePorts | null =
        ports.front.length || ports.rear.length ? ports : null
      return api<DeviceType>(`/api/device-types/${deviceType.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ image_ports: body } as DeviceTypeWritePayload),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-type", deviceType.id] })
      setDirty(false)
      toast.success("Photo ports saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!deviceType.front_image && !deviceType.rear_image)
    return (
      <p className="max-w-2xl text-sm text-muted-foreground">
        This device type has no front or rear image yet. Upload one on the
        device type (Edit → images), then place ports on it here.
      </p>
    )

  const selected = sel != null ? markers[sel] : null
  const pct = (v: number) => Math.round(v * 1000) / 10

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs<Side>
          value={side}
          onValueChange={(v) => {
            setSide(v)
            setSel(null)
          }}
          items={[
            { value: "front", label: "Front", count: ports.front.length || null },
            { value: "rear", label: "Rear", count: ports.rear.length || null },
          ]}
        />
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            className="ck"
            checked={snap}
            onChange={(e) => setSnap(e.target.checked)}
          />
          Snap to fine grid
        </label>
        <p className="text-[12px] text-muted-foreground">
          Drag a port onto the photo, then nudge with the arrow keys or the
          fields for pixel-precise placement.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[240px_1fr]">
        {/* Palette */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Unplaced ports
          </h3>
          {KINDS.map((k) => {
            const items = (templatesByKind[k] ?? []).filter(
              (t) => !placed.has(`${k}:${t.name}`)
            )
            if (!items.length) return null
            return (
              <details key={k} open className="space-y-1">
                <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                  {KIND_LABEL[k]} <span className="num">({items.length})</span>
                </summary>
                <div className="flex flex-wrap gap-1 pt-1">
                  {items.map((t) => (
                    <span
                      key={t.id}
                      draggable={canWrite}
                      onDragStart={(e) =>
                        e.dataTransfer.setData(
                          "text/plain",
                          `${k}:${t.name}`
                        )
                      }
                      title={t.name}
                      className={cn(
                        "max-w-full cursor-grab truncate rounded-[4px] border border-border bg-muted/40 px-1.5 py-1 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-foreground",
                        !canWrite && "cursor-default opacity-60"
                      )}
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              </details>
            )
          })}
          {selected && (
            <div className="grid gap-2 border-t border-border pt-3">
              <span className="text-[11px] font-medium text-foreground">
                {selected.name}
              </span>
              <div className="grid grid-cols-2 gap-2">
                {(["x", "y", "w", "h"] as const).map((axis) => (
                  <Field key={axis} label={axis.toUpperCase() + " %"}>
                    <Input
                      type="number"
                      step={0.1}
                      value={pct(selected[axis])}
                      disabled={!canWrite}
                      onChange={(e) =>
                        patchSel({
                          [axis]: clamp01((Number(e.target.value) || 0) / 100),
                        })
                      }
                      className="h-7 text-[12px]"
                    />
                  </Field>
                ))}
              </div>
              {canWrite && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    setMarkers(markers.filter((_, i) => i !== sel))
                    setSel(null)
                  }}
                >
                  Remove from photo
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Canvas — the photo with markers */}
        <div className="min-w-0">
          {image ? (
            <div
              ref={imgRef}
              className="relative w-full overflow-hidden rounded-md border border-border bg-muted/30 select-none"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onClick={() => setSel(null)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image}
                alt={`${side} of ${deviceType.name}`}
                className="pointer-events-none block w-full"
                draggable={false}
              />
              {markers.map((m, i) => (
                <div
                  key={`${markerKey(m)}-${i}`}
                  onPointerDown={(e) => onPointerDownMarker(e, i, "move")}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSel(i)
                  }}
                  title={m.name}
                  style={{
                    left: `${(m.x - m.w / 2) * 100}%`,
                    top: `${(m.y - m.h / 2) * 100}%`,
                    width: `${m.w * 100}%`,
                    height: `${m.h * 100}%`,
                  }}
                  className={cn(
                    "absolute cursor-move rounded-[2px] border",
                    i === sel
                      ? "border-primary bg-primary/30 ring-1 ring-primary"
                      : "border-sky-400/80 bg-sky-400/20 hover:bg-sky-400/30"
                  )}
                >
                  {i === sel && canWrite && (
                    <span
                      onPointerDown={(e) => onPointerDownMarker(e, i, "resize")}
                      className="absolute -right-1 -bottom-1 h-2.5 w-2.5 cursor-se-resize rounded-[1px] border border-background bg-primary"
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No {side} image — switch sides or upload one on the device type.
            </p>
          )}
        </div>
      </div>

      {canWrite && (
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save photo ports"}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty}
            onClick={() => {
              setPorts(deviceType.image_ports ?? { front: [], rear: [] })
              setDirty(false)
              setSel(null)
            }}
          >
            Discard changes
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {markers.length} on this side · normalized coordinates scale to the
            3D view.
          </span>
        </div>
      )}
    </div>
  )
}
