import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Search, Wand2, X } from "lucide-react"

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field } from "@/components/forms"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { cn } from "@/lib/utils"

// Placeable kinds — the port-ish component templates PLUS inventory items
// (disk bays and other hardware, drawn status-coloured; never cable-able).
export type PhotoMarkerKind = SlotKind | "inventory-item"
const KINDS: PhotoMarkerKind[] = [
  "interface",
  "console-port",
  "console-server-port",
  "power-port",
  "power-outlet",
  "front-port",
  "rear-port",
  "aux-port",
  "inventory-item",
]
const KIND_LABEL: Record<PhotoMarkerKind, string> = {
  interface: "Interfaces",
  "console-port": "Console",
  "console-server-port": "Console server",
  "power-port": "Power ports",
  "power-outlet": "Power outlets",
  "front-port": "Front ports",
  "rear-port": "Rear ports",
  "aux-port": "Aux ports",
  "inventory-item": "Hardware (disks, PSUs…)",
}

const DEFAULT_W = 0.03
const DEFAULT_H = 0.35
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const markerKey = (m: { kind: string; name: string }) => `${m.kind}:${m.name}`

/** Natural (human) compare so "Ethernet1/0/2" sorts before ".../11". Splits
 * each name into digit / non-digit runs and compares run-by-run. */
const naturalCompare = (a: string, b: string): number => {
  const ax = a.match(/(\d+|\D+)/g) ?? []
  const bx = b.match(/(\d+|\D+)/g) ?? []
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const as = ax[i],
      bs = bx[i]
    if (as === undefined) return -1
    if (bs === undefined) return 1
    const an = Number(as),
      bn = Number(bs)
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn
    } else if (as !== bs) {
      return as < bs ? -1 : 1
    }
  }
  return 0
}

type Side = "front" | "rear"

interface FillOpts {
  kind: PhotoMarkerKind
  from: string
  to: string
  rows: 1 | 2
  /** 2-row order: column = belly-to-belly (1 top, 2 bottom, 3 top…);
   * row = fill the top row first, then the bottom. */
  order: "column" | "row"
  x1: number
  y1: number
  x2: number
  row2y: number
  w: number
  h: number
}

/**
 * "Photo ports" builder — place port markers precisely on a device type's real
 * front/rear photo. Drag one at a time, or use the **auto-fill** tool to lay a
 * whole run of ports at once (rows, spacing, belly-to-belly order). Positions
 * are normalized 0..1, so the 2D image faceplate and the 3D device face render
 * them live-lit at any size.
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
    const out: Partial<Record<PhotoMarkerKind, PortComponent[]>> = {}
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
  const [search, setSearch] = useState("")
  const [fill, setFill] = useState<FillOpts | null>(null)
  const [pick, setPick] = useState<null | "x1" | "x2">(null)
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
  const setMarkers = (ms: ImagePortMarker[]) => update({ ...ports, [side]: ms })

  // Placed keys (both sides) so the palette hides what's already down.
  const placed = useMemo(() => {
    const s = new Set<string>()
    for (const sd of ["front", "rear"] as const)
      for (const m of ports[sd]) s.add(markerKey(m))
    return s
  }, [ports])

  // Unplaced templates per kind, natural-sorted, filtered by the search box.
  const unplacedByKind = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out: Partial<Record<PhotoMarkerKind, PortComponent[]>> = {}
    for (const k of KINDS) {
      out[k] = (templatesByKind[k] ?? [])
        .filter((t) => !placed.has(`${k}:${t.name}`))
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .sort((a, b) => naturalCompare(a.name, b.name))
    }
    return out
  }, [templatesByKind, placed, search])

  const snapV = (v: number) => (snap ? Math.round(v * 200) / 200 : v)

  const patchSel = (patch: Partial<ImagePortMarker>) => {
    if (sel == null) return
    setMarkers(markers.map((m, i) => (i === sel ? { ...m, ...patch } : m)))
  }
  const patchAt = (i: number, patch: Partial<ImagePortMarker>) =>
    setMarkers(markers.map((m, k) => (k === i ? { ...m, ...patch } : m)))

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
  const endDrag = () => {
    drag.current = null
  }

  // Click on the image: set a fill anchor when picking, else deselect.
  const onCanvasClick = (e: React.MouseEvent) => {
    const box = imgRef.current?.getBoundingClientRect()
    if (pick && fill && box) {
      const x = clamp01((e.clientX - box.left) / box.width)
      const y = clamp01((e.clientY - box.top) / box.height)
      setFill(
        pick === "x1" ? { ...fill, x1: x, y1: y } : { ...fill, x2: x }
      )
      setPick(null)
      return
    }
    setSel(null)
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
    setMarkers([...markers, { kind, name, x, y, w: DEFAULT_W, h: DEFAULT_H }])
    setSel(markers.length)
  }

  // Arrow-key nudge for the selected marker (Shift = coarse).
  useEffect(() => {
    if (sel == null || !canWrite) return
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack typing in the numeric inputs.
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      const step = e.shiftKey ? 0.01 : 0.002
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      if (e.key in d) {
        e.preventDefault()
        const [dx, dy] = d[e.key]
        setMarkers(
          markers.map((m, i) =>
            i === sel ? { ...m, x: clamp01(m.x + dx), y: clamp01(m.y + dy) } : m
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

  // ── Auto-fill: lay a whole run of ports in one shot ──────────────────────
  const openFill = () => {
    // Seed from the first kind that has unplaced ports (interfaces first).
    const kind = KINDS.find((k) => (unplacedByKind[k] ?? []).length) ?? "interface"
    const names = unplacedByKind[kind] ?? []
    setSel(null)
    setSearch("")
    setFill({
      kind,
      from: names[0]?.name ?? "",
      to: names[names.length - 1]?.name ?? "",
      rows: 2,
      order: "column",
      x1: 0.06,
      y1: 0.4,
      x2: 0.94,
      row2y: 0.66,
      w: 0.02,
      h: 0.22,
    })
  }

  // When the fill kind changes (or its list loads), keep from/to valid by
  // snapping them back to that kind's full range.
  useEffect(() => {
    if (!fill) return
    const names = (unplacedByKind[fill.kind] ?? []).map((t) => t.name)
    if (!names.includes(fill.from) || !names.includes(fill.to)) {
      setFill({
        ...fill,
        from: names[0] ?? "",
        to: names[names.length - 1] ?? "",
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill?.kind, unplacedByKind])

  // The port names the current fill options select (natural-sorted, from..to).
  const fillNames = useMemo(() => {
    if (!fill) return []
    const all = (unplacedByKind[fill.kind] ?? []).map((t) => t.name)
    const i = all.indexOf(fill.from)
    const j = all.indexOf(fill.to)
    if (i < 0 || j < 0) return all
    return all.slice(Math.min(i, j), Math.max(i, j) + 1)
  }, [fill, unplacedByKind])

  // Compute the marker for each name from the fill geometry.
  const fillPreview = useMemo<ImagePortMarker[]>(() => {
    if (!fill) return []
    const n = fillNames.length
    if (!n) return []
    const cols = fill.rows === 1 ? n : Math.ceil(n / 2)
    const colX = (col: number) =>
      cols > 1 ? fill.x1 + ((fill.x2 - fill.x1) * col) / (cols - 1) : fill.x1
    return fillNames.map((name, idx) => {
      let col: number
      let bottom: boolean
      if (fill.rows === 1) {
        col = idx
        bottom = false
      } else if (fill.order === "column") {
        col = Math.floor(idx / 2)
        bottom = idx % 2 === 1
      } else {
        col = idx % cols
        bottom = idx >= cols
      }
      return {
        kind: fill.kind,
        name,
        x: clamp01(colX(col)),
        y: clamp01(bottom ? fill.row2y : fill.y1),
        w: fill.w,
        h: fill.h,
      }
    })
  }, [fill, fillNames])

  const applyFill = () => {
    if (!fill || !fillPreview.length) return
    // Replace any existing markers of the same names, then append.
    const names = new Set(fillPreview.map((m) => m.name))
    const kept = markers.filter(
      (m) => !(m.kind === fill.kind && names.has(m.name))
    )
    setMarkers([...kept, ...fillPreview])
    setFill(null)
    setPick(null)
    toast.success(`Placed ${fillPreview.length} ports`)
  }

  const save = useMutation({
    mutationFn: () => {
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
  const fillKinds = KINDS.filter((k) => (unplacedByKind[k] ?? []).length)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs<Side>
          value={side}
          onValueChange={(v) => {
            setSide(v)
            setSel(null)
            setFill(null)
          }}
          items={[
            {
              value: "front",
              label: "Front",
              count: ports.front.length || null,
            },
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
        {canWrite && (
          <Button variant="outline" size="sm" onClick={openFill}>
            <Wand2 className="h-3.5 w-3.5" /> Auto-fill a run
          </Button>
        )}
        <p className="text-[12px] text-muted-foreground">
          Drag a port onto the photo, or auto-fill a whole run at once.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[260px_1fr]">
        {/* Palette (scrolls independently so a long port list can't stretch
            the page) */}
        <div className="flex max-h-[70vh] flex-col rounded-lg border border-border">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ports…"
                className="h-8 pl-7 text-[12px]"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Unplaced ports
            </h3>
            {KINDS.every((k) => !(unplacedByKind[k] ?? []).length) && (
              <p className="text-[11px] text-muted-foreground">
                {search ? "No matches." : "Everything is placed."}
              </p>
            )}
            {KINDS.map((k) => {
              const items = unplacedByKind[k] ?? []
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
                          e.dataTransfer.setData("text/plain", `${k}:${t.name}`)
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
                            [axis]: clamp01(
                              (Number(e.target.value) || 0) / 100
                            ),
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
        </div>

        {/* Canvas — the photo with markers */}
        <div className="min-w-0 space-y-3">
          {fill && (
            <FillPanel
              fill={fill}
              setFill={setFill}
              count={fillNames.length}
              kinds={fillKinds}
              names={(unplacedByKind[fill.kind] ?? []).map((t) => t.name)}
              pick={pick}
              setPick={setPick}
              onApply={applyFill}
              onCancel={() => {
                setFill(null)
                setPick(null)
              }}
            />
          )}
          {image ? (
            <div
              ref={imgRef}
              className={cn(
                "relative w-full overflow-hidden rounded-md border border-border bg-muted/30 select-none",
                pick && "cursor-crosshair ring-2 ring-primary"
              )}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onClick={onCanvasClick}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image}
                alt={`${side} of ${deviceType.name}`}
                className="pointer-events-none block w-full"
                draggable={false}
              />
              {/* Live fill preview — amber ghosts, not interactive. */}
              {fill &&
                fillPreview.map((m, i) => (
                  <div
                    key={`prev-${i}`}
                    className="pointer-events-none absolute rounded-[2px] border border-dashed border-amber-400 bg-amber-400/25"
                    style={{
                      left: `${(m.x - m.w / 2) * 100}%`,
                      top: `${(m.y - m.h / 2) * 100}%`,
                      width: `${m.w * 100}%`,
                      height: `${m.h * 100}%`,
                    }}
                  />
                ))}
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
                      onPointerDown={(e) =>
                        onPointerDownMarker(e, i, "resize")
                      }
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
        <div className="sticky bottom-0 z-10 -mx-1 flex items-center gap-2 border-t border-border bg-background/95 px-1 py-2.5 backdrop-blur">
          <Button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save photo ports"}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty}
            onClick={() => {
              setPorts(deviceType.image_ports ?? { front: [], rear: [] })
              setDirty(false)
              setSel(null)
              setFill(null)
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

/** The auto-fill controls — pick a port run + geometry; the canvas shows a
 * live amber preview while it's open. */
function FillPanel({
  fill,
  setFill,
  count,
  kinds,
  names,
  pick,
  setPick,
  onApply,
  onCancel,
}: {
  fill: FillOpts
  setFill: (f: FillOpts) => void
  count: number
  kinds: PhotoMarkerKind[]
  names: string[]
  pick: null | "x1" | "x2"
  setPick: (p: null | "x1" | "x2") => void
  onApply: () => void
  onCancel: () => void
}) {
  const set = (patch: Partial<FillOpts>) => setFill({ ...fill, ...patch })
  const numPct = (key: "x1" | "y1" | "x2" | "row2y" | "w" | "h") => (
    <Field label={FILL_LABEL[key]}>
      <Input
        type="number"
        step={0.5}
        value={Math.round(fill[key] * 1000) / 10}
        onChange={(e) =>
          set({ [key]: Math.max(0, Math.min(1, (Number(e.target.value) || 0) / 100)) })
        }
        className="h-7 text-[12px]"
      />
    </Field>
  )

  return (
    <div className="grid gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium">
          <Wand2 className="h-3.5 w-3.5 text-primary" /> Auto-fill a run
          <span className="text-muted-foreground">
            · {count} port{count === 1 ? "" : "s"}
          </span>
        </span>
        <button
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Kind">
          <Select
            value={fill.kind}
            onValueChange={(v) => {
              const k = v as PhotoMarkerKind
              set({ kind: k }) // from/to reseed below via effect-free guard
            }}
          >
            <SelectTrigger size="sm" className="h-7 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="From port">
          <Select value={fill.from} onValueChange={(v) => set({ from: v })}>
            <SelectTrigger size="sm" className="h-7 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {names.map((n) => (
                <SelectItem key={n} value={n} className="font-mono text-[11px]">
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="To port">
          <Select value={fill.to} onValueChange={(v) => set({ to: v })}>
            <SelectTrigger size="sm" className="h-7 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {names.map((n) => (
                <SelectItem key={n} value={n} className="font-mono text-[11px]">
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Field label="Rows">
          <Select
            value={String(fill.rows)}
            onValueChange={(v) => set({ rows: Number(v) as 1 | 2 })}
          >
            <SelectTrigger size="sm" className="h-7 w-20 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 row</SelectItem>
              <SelectItem value="2">2 rows</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {fill.rows === 2 && (
          <Field label="Numbering">
            <Select
              value={fill.order}
              onValueChange={(v) => set({ order: v as "column" | "row" })}
            >
              <SelectTrigger size="sm" className="h-7 w-52 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="column">
                  Belly-to-belly (1 top, 2 bottom…)
                </SelectItem>
                <SelectItem value="row">Top row first, then bottom</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>

      {/* Anchors: type the %, or click them straight onto the photo. */}
      <div className="grid gap-3 sm:grid-cols-6">
        {numPct("x1")}
        {numPct("y1")}
        {numPct("x2")}
        {fill.rows === 2 && numPct("row2y")}
        {numPct("w")}
        {numPct("h")}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Button
          size="sm"
          variant={pick === "x1" ? "default" : "outline"}
          className="h-7"
          onClick={() => setPick(pick === "x1" ? null : "x1")}
        >
          {pick === "x1" ? "Click the photo…" : "Set first port on photo"}
        </Button>
        <Button
          size="sm"
          variant={pick === "x2" ? "default" : "outline"}
          className="h-7"
          onClick={() => setPick(pick === "x2" ? null : "x2")}
        >
          {pick === "x2" ? "Click the photo…" : "Set last (top-row) port"}
        </Button>
        <span className="text-muted-foreground">
          First = top-left port center; Last = the last top-row port. Columns
          space evenly between them.
        </span>
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-2">
        <Button size="sm" onClick={onApply} disabled={count === 0}>
          Place {count} port{count === 1 ? "" : "s"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

const FILL_LABEL: Record<string, string> = {
  x1: "First X %",
  y1: "Top row Y %",
  x2: "Last X %",
  row2y: "Bottom row Y %",
  w: "Width %",
  h: "Height %",
}
