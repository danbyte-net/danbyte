import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import type { ThreeEvent } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Check, Redo2, Search, Undo2 } from "lucide-react"
import * as THREE from "three"

import { ApiError, api, saveModelPorts } from "@/lib/api"
import type {
  DeviceType,
  ImagePorts,
  Model3DFit,
  Model3DFront,
  Model3DUp,
  ModelPortsState,
  Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  MODEL_PORT_KINDS,
  MODEL_PORT_KIND_LABEL,
  PORT_MARKER_M,
  denormalisePoint,
  historyOf,
  nextUnmapped,
  placePorts,
  portFromHit,
  portKey,
  portsFromPhotos,
  pushHistory,
  redo,
  rowFill,
  runBetween,
  savePayload,
  undo,
} from "@/lib/model-ports"
import type { History, ModelPort, ModelPortKind, V3 } from "@/lib/model-ports"
import { naturalCompare } from "@/lib/natural-sort"
import { cn } from "@/lib/utils"
import { TEMPLATE_ENDPOINT } from "@/components/component-template-dialog"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"

import { useDeviceModel } from "./device-model"
import { snapToSurface, uprightOf, hitNormal } from "./device-model-ports"
import type { Upright } from "./device-model-ports"
import { TextSprite } from "./text-sprite"
import { modelScale, modelTargetM } from "./world"

/**
 * "Map ports": the dialog body that places a type's (or a device's) ports
 * on its 3D model, as photo ports are placed on a photo.
 *
 * Pick a port in the list, click the model: a raycast puts the marker at the
 * hit with the surface's normal, and the next unmapped port is picked.
 * Drag a marker over the surface to move it; Backspace clears the picked
 * port, Enter skips to the next unmapped one. Row: place a row's first and
 * last port and the ones between fill in evenly, in two rows when the ports
 * split odd/even (the common switch layout). Copy from photo ports projects
 * the photo markers onto the model's front and rear as a start. Undo/redo
 * work inside the dialog; Save writes the whole mapping in one PUT with the
 * version it opened at.
 *
 * Positions are kept 0..1 in the model's upright bounding box (see
 * lib/model-ports), so the room draws them on the model at any fit.
 */

/** Each kind's component list: templates on a type, the device's own
 * components on a device. */
const DEVICE_ENDPOINT: Record<ModelPortKind, string> = {
  interface: "interfaces",
  "front-port": "front-ports",
  "rear-port": "rear-ports",
  "console-port": "console-ports",
  "console-server-port": "console-server-ports",
  "power-port": "power-ports",
  "power-outlet": "power-outlets",
}

interface ListedPort {
  kind: ModelPortKind
  name: string
}

const MAPPED = "#0ea5e9"
const PICKED = "#fbbf24"
const ROW_START = "#a855f7"
const Z_AXIS = new THREE.Vector3(0, 0, 1)

export default function ModelPortsEditor({
  kind,
  id,
  typeId,
  url,
  up,
  front,
  fit,
  ownImagePorts,
  onDone,
}: {
  kind: "device-types" | "devices"
  id: string
  /** The device type: its templates (on a type), photo ports and size. */
  typeId: string
  /** The model to map on - the one the room draws. */
  url: string
  up: Model3DUp
  front: Model3DFront
  fit: Model3DFit
  /** A device's own photo-port override, preferred over the type's. */
  ownImagePorts?: ImagePorts | null
  onDone: (saved: boolean) => void
}) {
  const qc = useQueryClient()
  const stateKey = ["model-ports", kind, id] as const
  const state = useQuery({
    queryKey: stateKey,
    queryFn: () => api<ModelPortsState>(`/api/${kind}/${id}/model-ports/`),
  })
  const dt = useQuery({
    queryKey: ["device-type", typeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${typeId}/`),
    staleTime: 5 * 60_000,
  })
  const lists = useQueries({
    queries: MODEL_PORT_KINDS.map((k) => ({
      queryKey: ["model-port-list", kind, id, k],
      queryFn: () =>
        api<Paginated<{ name: string }>>(
          kind === "devices"
            ? `/api/${DEVICE_ENDPOINT[k]}/?device=${id}&page_size=1000`
            : `/api/${TEMPLATE_ENDPOINT[k]}/?device_type=${typeId}&page_size=1000`
        ),
    })),
  })
  const listsKey = lists.map((q) => q.dataUpdatedAt).join(",")

  const [history, setHistory] = useState<History<ModelPort[]> | null>(null)
  const [version, setVersion] = useState("")
  useEffect(() => {
    if (!state.data || history) return
    const start =
      state.data.model_ports ??
      (kind === "devices" ? state.data.effective : null) ??
      null
    setHistory(historyOf(start?.ports ?? []))
    setVersion(state.data.version)
  }, [state.data, history, kind])
  const ports = useMemo(() => history?.present ?? [], [history])
  const commit = useCallback(
    (next: ModelPort[]) => setHistory((h) => (h ? pushHistory(h, next) : h)),
    []
  )

  // The port list: every component of each kind, natural order, plus any
  // mapped name no component carries (still listed, so it can be cleared).
  const listed = useMemo(() => {
    const out: ListedPort[] = []
    MODEL_PORT_KINDS.forEach((k, i) => {
      const names = new Set((lists[i]?.data?.results ?? []).map((r) => r.name))
      for (const p of ports) if (p.kind === k) names.add(p.name)
      for (const name of [...names].sort(naturalCompare))
        out.push({ kind: k, name })
    })
    return out
    // `lists` is a new array each render; its data changes with listsKey.
  }, [listsKey, ports])
  const mapped = useMemo(() => new Set(ports.map(portKey)), [ports])

  const [search, setSearch] = useState("")
  const [picked, setPicked] = useState<ListedPort | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [mode, setMode] = useState<"single" | "row">("single")
  const [rows, setRows] = useState<1 | 2>(2)
  const [rowStart, setRowStart] = useState<ModelPort | null>(null)
  const [upright, setUpright] = useState<Upright | null>(null)
  const [saving, setSaving] = useState(false)

  // Start on the first unmapped port once the list is in.
  useEffect(() => {
    if (!picked && history && listed.length)
      setPicked(nextUnmapped(listed, mapped, null) ?? listed[0])
  }, [listed.length, history])

  const advance = () => setPicked((cur) => nextUnmapped(listed, mapped, cur))

  /** A click on the model with a port picked. */
  const place = (hit: { p: V3; n: V3 }) => {
    if (!picked) return
    const port: ModelPort = { ...picked, ...hit }
    if (mode === "row") {
      if (!rowStart || rowStart.kind !== port.kind) {
        commit(placePorts(ports, [port]))
        setRowStart(port)
        return
      }
      const all = listed.filter((l) => l.kind === port.kind).map((l) => l.name)
      // From the first click to the second, in the list's order either way:
      // the first port's row takes the odd ones on two rows.
      const names = runBetween(all, rowStart.name, port.name)
      const run = rowFill(rowStart, port, names, port.kind, rows)
      const onSurface = upright
        ? run.map((r, i) =>
            i === 0 || i === run.length - 1 ? r : snapToSurface(upright, r)
          )
        : run
      commit(placePorts(ports, onSurface))
      setRowStart(null)
      setPicked(
        nextUnmapped(listed, new Set([...mapped, ...run.map(portKey)]), picked)
      )
      return
    }
    commit(placePorts(ports, [port]))
    setPicked(nextUnmapped(listed, new Set([...mapped, portKey(port)]), picked))
  }

  const clearPicked = () => {
    if (!picked) return
    commit(ports.filter((p) => portKey(p) !== portKey(picked)))
    if (rowStart && portKey(rowStart) === portKey(picked)) setRowStart(null)
  }

  const copyPhotos = () => {
    const photo = ownImagePorts ?? dt.data?.image_ports ?? null
    const fresh = portsFromPhotos(photo, ports)
    if (!fresh.length) {
      toast.message("No photo ports to copy.")
      return
    }
    commit(
      placePorts(
        ports,
        upright ? fresh.map((f) => snapToSurface(upright, f)) : fresh
      )
    )
    toast.success(`Copied ${fresh.length} photo ports`)
  }

  const save = async () => {
    if (!upright) return
    setSaving(true)
    try {
      const out = await saveModelPorts(
        kind,
        id,
        savePayload(upright.size, ports, version)
      )
      qc.setQueryData(stateKey, out)
      void qc.invalidateQueries({ queryKey: ["device-face-ports"] })
      void qc.invalidateQueries({ queryKey: ["floor-plan-scene"] })
      onDone(true)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        toast.error(
          "Someone saved a newer mapping. Close and reopen to see it."
        )
      else apiErrorToast(e, "Couldn't save the ports.")
    } finally {
      setSaving(false)
    }
  }

  // Keyboard: Enter → next unmapped, Backspace/Delete → clear the picked
  // port, Ctrl/Cmd+Z → undo, with Shift (or Y) → redo. Not while typing.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === "z" || e.key === "Z" || e.key === "y")) {
      e.preventDefault()
      setHistory((h) =>
        h ? (e.shiftKey || e.key === "y" ? redo(h) : undo(h)) : h
      )
    } else if (e.key === "Enter") {
      e.preventDefault()
      advance()
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault()
      clearPicked()
    }
  }
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener("keydown", fn)
    return () => window.removeEventListener("keydown", fn)
  }, [])

  if (state.isError) return <QueryError error={state.error} />
  if (!history) return <Loading />

  const q = search.trim().toLowerCase()
  const shown = listed.filter((l) => !q || l.name.toLowerCase().includes(q))
  const target = dt.data ? modelTargetM(dt.data) : null

  return (
    <div className="grid gap-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs
          items={[
            { value: "single", label: "One port" },
            { value: "row", label: "Row" },
          ]}
          value={mode}
          onValueChange={(v) => {
            setMode(v)
            setRowStart(null)
          }}
        />
        {mode === "row" && (
          <SegmentedTabs
            items={[
              { value: "1", label: "1 row" },
              { value: "2", label: "2 rows" },
            ]}
            value={String(rows)}
            onValueChange={(v) => setRows(v === "1" ? 1 : 2)}
          />
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={copyPhotos}>
            Copy from photo ports
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Undo"
            disabled={!history.past.length}
            onClick={() => setHistory((h) => (h ? undo(h) : h))}
          >
            <Undo2 />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Redo"
            disabled={!history.future.length}
            onClick={() => setHistory((h) => (h ? redo(h) : h))}
          >
            <Redo2 />
          </Button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_16rem]">
        <div className="relative h-[60vh] min-h-80 overflow-hidden rounded-md border border-border bg-muted/30">
          <Canvas
            frameloop="demand"
            dpr={[1, 2]}
            camera={{ fov: 35, position: [1, 1, -2] }}
            gl={{ antialias: true, preserveDrawingBuffer: true }}
            fallback={<Loading />}
          >
            <ambientLight intensity={0.7} />
            <directionalLight position={[2, 4, -3]} intensity={1.4} />
            <directionalLight position={[-2, 2, 3]} intensity={0.5} />
            <EditorScene
              url={url}
              up={up}
              front={front}
              fit={fit}
              target={target}
              ports={ports}
              picked={picked}
              hover={hover}
              rowStart={rowStart}
              onUpright={setUpright}
              onHover={setHover}
              onPlace={place}
              onPick={(p) =>
                setPicked({ kind: p.kind as ModelPortKind, name: p.name })
              }
              onDragStart={() => commit(ports)}
              onDrag={(port) =>
                // A drag moves the port in place; its start went on the
                // history, so one undo puts it back.
                setHistory((h) =>
                  h ? { ...h, present: placePorts(h.present, [port]) } : h
                )
              }
            />
          </Canvas>
          <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-popover/90 px-2 py-1 text-[11px] text-muted-foreground">
            {picked ? (
              <span>
                {mode === "row" && rowStart
                  ? `Row from ${rowStart.name} · click its last port`
                  : mode === "row"
                    ? "Click the row's first port"
                    : "Click the model"}
                {" · "}
                <span className="font-mono text-foreground">{picked.name}</span>
              </span>
            ) : (
              "Every port is mapped"
            )}
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ports"
              aria-label="Search ports"
              className="h-8 pl-7"
            />
          </div>
          <div className="h-[calc(60vh-5rem)] min-h-64 overflow-y-auto rounded-md border border-border">
            {MODEL_PORT_KINDS.map((k) => {
              const group = shown.filter((l) => l.kind === k)
              if (!group.length) return null
              const done = listed.filter(
                (l) => l.kind === k && mapped.has(portKey(l))
              ).length
              const total = listed.filter((l) => l.kind === k).length
              return (
                <div key={k}>
                  <div className="sticky top-0 flex items-center justify-between bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    <span>{MODEL_PORT_KIND_LABEL[k]}</span>
                    <span className="num">
                      {done}/{total}
                    </span>
                  </div>
                  {group.map((l) => {
                    const key = portKey(l)
                    const on = picked && portKey(picked) === key
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setPicked(l)}
                        onMouseEnter={() => setHover(key)}
                        onMouseLeave={() => setHover(null)}
                        className={cn(
                          "flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[12px] hover:bg-muted/60",
                          on && "bg-amber-500/15"
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {l.name}
                        </span>
                        {mapped.has(key) && (
                          <Check className="size-3.5 shrink-0 text-sky-500" />
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={advance}
              disabled={!listed.length}
            >
              Next unmapped <Kbd>Enter</Kbd>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={clearPicked}
              disabled={!picked || !mapped.has(portKey(picked))}
            >
              Clear <Kbd>⌫</Kbd>
            </Button>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          <span className="num">{ports.length}</span> mapped
          {kind === "devices" && state.data?.source === "type" && (
            <> · from device type</>
          )}
        </span>
        <div className="flex gap-2">
          {kind === "devices" && state.data?.model_ports != null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={async () => {
                setSaving(true)
                try {
                  await saveModelPorts(kind, id, {
                    version,
                    model_ports: null,
                  })
                  void qc.invalidateQueries({ queryKey: stateKey })
                  void qc.invalidateQueries({ queryKey: ["device-face-ports"] })
                  onDone(true)
                } catch (e) {
                  apiErrorToast(e)
                } finally {
                  setSaving(false)
                }
              }}
            >
              Use type's ports
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !upright}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The model, the markers, and the pointer. */
function EditorScene({
  url,
  up,
  front,
  fit,
  target,
  ports,
  picked,
  hover,
  rowStart,
  onUpright,
  onHover,
  onPlace,
  onPick,
  onDragStart,
  onDrag,
}: {
  url: string
  up: Model3DUp
  front: Model3DFront
  fit: Model3DFit
  target: { w?: number; h?: number; d?: number } | null
  ports: ModelPort[]
  picked: ListedPort | null
  hover: string | null
  rowStart: ModelPort | null
  onUpright: (u: Upright | null) => void
  onHover: (key: string | null) => void
  onPlace: (hit: { p: V3; n: V3 }) => void
  onPick: (port: ModelPort) => void
  onDragStart: () => void
  onDrag: (port: ModelPort) => void
}) {
  const entry = useDeviceModel(url)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as {
    enabled: boolean
  } | null
  const invalidate = useThree((s) => s.invalidate)
  const upright = useMemo(
    () => (entry?.scene ? uprightOf(entry.scene, up, front) : null),
    [entry?.scene, up, front]
  )
  useEffect(() => {
    onUpright(upright)
  }, [upright, onUpright])
  const radius = upright ? Math.max(...upright.size) : 1
  useEffect(() => {
    if (!upright) return
    const d = Math.hypot(...upright.size) * 1.4
    camera.position.set(d * 0.3, d * 0.5, -d * 0.85)
    camera.near = d / 500
    camera.far = d * 50
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [upright, camera, invalidate])

  // A marker's radius in model units: 8 mm at the size the room fits the
  // model to, held between 0.4% and 2% of the model so it stays findable.
  const markerR = useMemo(() => {
    if (!upright) return 0.01
    const scale = modelScale(upright.size, target, fit)
    const want = PORT_MARKER_M / 2 / (scale || 1)
    return Math.min(Math.max(want, radius * 0.004), radius * 0.02)
  }, [upright, target, fit, radius])

  const [drag, setDrag] = useState<ModelPort | null>(null)
  // Let go anywhere - off the model too - and the drag ends.
  useEffect(() => {
    if (!drag) return
    const release = () => {
      setDrag(null)
      if (controls) controls.enabled = true
    }
    window.addEventListener("pointerup", release)
    return () => window.removeEventListener("pointerup", release)
  }, [drag, controls])

  if (!entry || entry.status === "loading") return null
  if (entry.status === "error" || !upright) return null

  const toHit = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    if (!e.face) return null
    const normal = hitNormal(e, e.ray.direction)
    if (!normal) return null
    const point = e.point.clone().add(new THREE.Vector3(...upright.center))
    return portFromHit(
      { point: point.toArray(), normal },
      upright.min,
      upright.max
    )
  }
  const endDrag = () => {
    if (!drag) return
    setDrag(null)
    if (controls) controls.enabled = true
  }
  const offset = upright.center.map((v) => -v) as V3

  return (
    <>
      <group
        position={offset}
        onClick={(e) => {
          e.stopPropagation()
          if (drag || e.delta > 4) return
          const hit = toHit(e)
          if (hit) onPlace(hit)
        }}
        onPointerMove={(e) => {
          if (!drag) return
          e.stopPropagation()
          const hit = toHit(e)
          if (hit) onDrag({ ...drag, ...hit })
        }}
        onPointerUp={endDrag}
      >
        <group rotation={upright.rotation}>
          <primitive object={upright.object} />
        </group>
      </group>
      {ports.map((p) => {
        const key = portKey(p)
        const at = new THREE.Vector3(
          ...denormalisePoint(p.p, upright.min, upright.max)
        ).add(new THREE.Vector3(...offset))
        const n = new THREE.Vector3(...p.n).normalize()
        const q = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, n)
        at.addScaledVector(n, markerR * 0.15)
        const isPicked = picked && portKey(picked) === key
        const isRow = rowStart && portKey(rowStart) === key
        const showLabel = isPicked || hover === key
        return (
          <group key={key}>
            <mesh
              position={at}
              quaternion={q}
              raycast={drag ? () => null : undefined}
              onPointerDown={(e) => {
                e.stopPropagation()
                onPick(p)
                onDragStart()
                setDrag(p)
                if (controls) controls.enabled = false
              }}
              onPointerUp={(e) => {
                e.stopPropagation()
                endDrag()
              }}
              onPointerOver={() => onHover(key)}
              onPointerOut={() => onHover(null)}
            >
              <circleGeometry args={[markerR * (isPicked ? 1.3 : 1), 20]} />
              <meshBasicMaterial
                color={isPicked ? PICKED : isRow ? ROW_START : MAPPED}
                side={THREE.DoubleSide}
                toneMapped={false}
              />
            </mesh>
            {showLabel && (
              <TextSprite
                text={p.name}
                heightM={markerR * 2.2}
                position={at
                  .clone()
                  .addScaledVector(n, markerR * 2)
                  .add(new THREE.Vector3(0, markerR * 2.5, 0))
                  .toArray()}
              />
            )}
          </group>
        )
      })}
      <OrbitControls makeDefault enableDamping={false} />
    </>
  )
}
