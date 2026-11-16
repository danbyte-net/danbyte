import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  DeviceStudio,
  DeviceType,
  DeviceTypeStudio,
  Model3DEffective,
  ModuleTypeOption,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { importChunk } from "@/lib/lazy-chunk"
import { generatedImagePorts, overwriteList } from "@/lib/model-studio"
import { FormCheckbox } from "@/components/forms/checkbox"
import { FormCombobox } from "@/components/forms/combobox"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import type {
  StudioResult,
  StudioSource,
} from "@/components/floorplan3d/studio"

/**
 * "Generate images" (docs/dcim/model-packs.md): the studio renders a model
 * into front, rear and 3D images with the ports and LEDs placed on them
 * (floorplan3d/studio, loaded with the dialog so three.js stays in the 3D
 * chunk). A device type stores them; a device renders its own installed
 * modules and can keep the port map as its photo-port override. Anything
 * made by hand stays unless ticked here.
 */

const TARGET_LABELS: Record<string, string> = {
  front: "Replace the front image",
  rear: "Replace the rear image",
  iso: "Replace the 3D image",
  image_ports: "Replace the photo ports",
}

type Urls = { front: string; rear: string; iso: string }

/** Render `source` once known; the result's object URLs go with it. */
function useRender(source: StudioSource | null) {
  const [state, setState] = useState<{
    result: StudioResult | null
    urls: Urls | null
    error: string | null
  }>({ result: null, urls: null, error: null })
  useEffect(() => {
    if (!source) return
    let live = true
    let urls: Urls | null = null
    setState({ result: null, urls: null, error: null })
    importChunk(() => import("@/components/floorplan3d/studio"))
      .then((m) => m.renderStudio(source))
      .then((result) => {
        if (!live) return
        urls = {
          front: URL.createObjectURL(result.front),
          rear: URL.createObjectURL(result.rear),
          iso: URL.createObjectURL(result.iso),
        }
        setState({ result, urls, error: null })
      })
      .catch((e: unknown) => {
        if (live)
          setState({
            result: null,
            urls: null,
            error:
              e instanceof Error
                ? e.message
                : "The model could not be rendered.",
          })
      })
    return () => {
      live = false
      if (urls) Object.values(urls).forEach((u) => URL.revokeObjectURL(u))
    }
  }, [source])
  return state
}

function Counts({ result }: { result: StudioResult }) {
  const ports = result.imagePorts.front.length + result.imagePorts.rear.length
  const leds = result.imageLeds.front.length + result.imageLeds.rear.length
  const notes = [
    ...result.unknownPorts.map((n) => `${n}: no such component`),
    ...result.offFace.map((n) => `${n}: on neither face`),
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="num">
        {ports} {ports === 1 ? "port" : "ports"} · {leds}{" "}
        {leds === 1 ? "LED" : "LEDs"}
      </span>
      {notes.length > 0 && (
        <HoverCard openDelay={100} closeDelay={60}>
          <HoverCardTrigger asChild>
            <button type="button" className="inline-flex">
              <Badge variant="warning">
                {notes.length === 1 ? "1 note" : `${notes.length} notes`}
              </Badge>
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="w-96 text-xs">
            <ul className="list-disc space-y-1 pl-4">
              {notes.slice(0, 40).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
}

function Shot({
  src,
  label,
  tall,
}: {
  src: string
  label: string
  tall?: boolean
}) {
  return (
    <figure className="grid gap-1">
      <figcaption className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </figcaption>
      <a href={src} download={`${label.toLowerCase()}.webp`}>
        <img
          src={src}
          alt={label}
          className={
            tall
              ? "max-h-56 rounded-md border border-border bg-muted object-contain"
              : "w-full rounded-md border border-border bg-muted object-contain"
          }
        />
      </a>
    </figure>
  )
}

/** The dialog's body while it renders, when it fails, and once done. */
function Body({
  error,
  queryError,
  result,
  urls,
  children,
}: {
  error: string | null
  queryError: unknown
  result: StudioResult | null
  urls: Urls | null
  children?: React.ReactNode
}) {
  if (queryError) return <QueryError error={queryError} />
  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (!result || !urls) return <Loading className="min-h-48" />
  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <Shot src={urls.front} label="Front" />
        <Shot src={urls.rear} label="Rear" />
        <Shot src={urls.iso} label="3D" tall />
      </div>
      <Counts result={result} />
      {children}
    </div>
  )
}

function Confirmations({
  targets,
  confirmed,
  onChange,
}: {
  targets: readonly string[]
  confirmed: ReadonlySet<string>
  onChange: (next: Set<string>) => void
}) {
  if (!targets.length) return null
  return (
    <div className="grid gap-2">
      {targets.map((t) => (
        <FormCheckbox
          key={t}
          label={TARGET_LABELS[t] ?? t}
          checked={confirmed.has(t)}
          onChange={(v) => {
            const next = new Set(confirmed)
            if (v) next.add(t)
            else next.delete(t)
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}

function useConfirmed(open: boolean) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (open) setConfirmed(new Set())
  }, [open])
  return [confirmed, setConfirmed] as const
}

/** A device type's images: rendered with its reference modules, stored. */
export function DeviceTypeStudioDialog({
  deviceTypeId,
  open,
  onOpenChange,
}: {
  deviceTypeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const payload = useQuery({
    queryKey: ["device-type-studio", deviceTypeId],
    queryFn: () =>
      api<DeviceTypeStudio>(`/api/device-types/${deviceTypeId}/studio/`),
    enabled: open,
    staleTime: 0,
  })
  const source = useMemo<StudioSource | null>(() => {
    const p = payload.data
    if (!open || !p?.model) return null
    return {
      model: p.model,
      size_mm: p.size_mm,
      frame_mm: p.frame_mm,
      bays: p.bays,
      leds: p.leds,
      bay_leds: Object.fromEntries(p.bays.map((b) => [b.name, b.leds])),
      ports: p.ports,
    }
  }, [open, payload.data])
  const { result, urls, error } = useRender(source)
  const [confirmed, setConfirmed] = useConfirmed(open)
  const handMade = payload.data?.hand_made ?? []

  const save = useMutation({
    mutationFn: () => {
      const p = payload.data!
      const r = result!
      const fd = new FormData()
      const ext = (b: Blob) => (b.type === "image/png" ? "png" : "webp")
      fd.append("front_image", r.front, `front.${ext(r.front)}`)
      fd.append("rear_image", r.rear, `rear.${ext(r.rear)}`)
      fd.append("iso_image", r.iso, `iso.${ext(r.iso)}`)
      fd.append(
        "image_ports",
        JSON.stringify(generatedImagePorts(r.imagePorts, p.frame_mm[0]))
      )
      fd.append("image_leds", JSON.stringify(r.imageLeds))
      fd.append("token", p.token)
      fd.append("overwrite", overwriteList(handMade, confirmed).join(","))
      return api<{
        written: string[]
        kept: string[]
        device_type: DeviceType
      }>(`/api/device-types/${deviceTypeId}/studio/`, {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: (out) => {
      qc.setQueryData(["device-type", deviceTypeId], out.device_type)
      qc.invalidateQueries({ queryKey: ["device-type", deviceTypeId] })
      qc.invalidateQueries({ queryKey: ["device-type-studio", deviceTypeId] })
      qc.invalidateQueries({ queryKey: ["rack-devices"] })
      qc.invalidateQueries({ queryKey: ["cabinet-devices"] })
      toast.success(
        out.kept.length
          ? `Images saved · ${out.kept.length} made by hand kept`
          : "Images saved"
      )
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="3xl">
        <DialogHeader>
          <DialogTitle>Generate images</DialogTitle>
        </DialogHeader>
        <Body
          error={error}
          queryError={payload.isError ? payload.error : null}
          result={result}
          urls={urls}
        >
          <Confirmations
            targets={handMade}
            confirmed={confirmed}
            onChange={setConfirmed}
          />
        </Body>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!result || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A device's own faces, with the modules it has installed. The images are
 * there to look at and download; the port map can become the device's
 * photo-port override (the faces every view draws stay the type's). */
export function DeviceStudioDialog({
  deviceId,
  model,
  open,
  onOpenChange,
}: {
  deviceId: string
  model: Model3DEffective
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  // Keyed on the value: a parent re-render must not render again.
  const modelKey = JSON.stringify(model)
  const payload = useQuery({
    queryKey: ["device-studio", deviceId],
    queryFn: () => api<DeviceStudio>(`/api/devices/${deviceId}/studio/`),
    enabled: open,
    staleTime: 0,
  })
  const source = useMemo<StudioSource | null>(() => {
    const p = payload.data
    if (!open || !p?.frame_mm) return null
    const m = JSON.parse(modelKey) as Model3DEffective
    return {
      model: {
        url: m.url,
        fit: m.fit,
        up: m.up,
        front: m.front,
        empty_mode: m.empty_mode,
      },
      size_mm: p.size_mm,
      frame_mm: p.frame_mm,
      bays: m.bays ?? [],
      leds: p.leds,
      bay_leds: p.bay_leds,
      ports: p.ports,
      covers: { covers: p.covers, bay_covers: p.bay_covers },
    }
  }, [open, payload.data, modelKey])
  const { result, urls, error } = useRender(source)
  const [confirmed, setConfirmed] = useConfirmed(open)
  const own = payload.data?.own_image_ports ? ["image_ports"] : []

  const save = useMutation({
    mutationFn: () =>
      api(`/api/devices/${deviceId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          image_ports: generatedImagePorts(
            result!.imagePorts,
            payload.data!.frame_mm![0]
          ),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-face-ports", deviceId] })
      toast.success("Photo ports saved")
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  const blocked = own.length > 0 && !confirmed.has("image_ports")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="3xl">
        <DialogHeader>
          <DialogTitle>Render faces</DialogTitle>
        </DialogHeader>
        <Body
          error={
            error ??
            (payload.data && !payload.data.frame_mm
              ? "The device has no type."
              : null)
          }
          queryError={payload.isError ? payload.error : null}
          result={result}
          urls={urls}
        >
          <Confirmations
            targets={own}
            confirmed={confirmed}
            onChange={setConfirmed}
          />
        </Body>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={!result || blocked || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save photo ports"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Which module each bay shows in the type's generated images (the
 * reference configuration); a bay left on "Cover" shows its cover. */
export function ModelReferenceDialog({
  deviceTypeId,
  open,
  onOpenChange,
}: {
  deviceTypeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const payload = useQuery({
    queryKey: ["device-type-studio", deviceTypeId],
    queryFn: () =>
      api<DeviceTypeStudio>(`/api/device-types/${deviceTypeId}/studio/`),
    enabled: open,
    staleTime: 0,
  })
  const types = useQuery({
    queryKey: ["module-types-picker"],
    queryFn: () => apiAll<ModuleTypeOption>("/api/module-types/?picker=1"),
    enabled: open,
    staleTime: 10 * 60_000,
  })
  const [picked, setPicked] = useState<Record<string, string | null>>({})
  useEffect(() => {
    if (!open || !payload.data) return
    setPicked(
      Object.fromEntries(
        payload.data.bays.map((b) => [b.name, b.module_type?.id ?? null])
      )
    )
  }, [open, payload.data])
  const options = (types.data?.results ?? []).map((t) => ({
    value: t.id,
    label:
      t.part_number && t.part_number !== t.name
        ? `${t.name} (${t.part_number})`
        : t.name,
  }))
  const save = useMutation({
    mutationFn: () => {
      const ref = Object.fromEntries(
        Object.entries(picked).filter((e): e is [string, string] => !!e[1])
      )
      return api(`/api/device-types/${deviceTypeId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          model_reference: Object.keys(ref).length ? ref : null,
        }),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-type", deviceTypeId] })
      qc.invalidateQueries({ queryKey: ["device-type-studio", deviceTypeId] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  const bays = payload.data?.bays ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Reference modules</DialogTitle>
        </DialogHeader>
        {payload.isError ? (
          <QueryError error={payload.error} />
        ) : !payload.data ? (
          <Loading className="min-h-32" />
        ) : bays.length === 0 ? (
          <p className="text-xs text-muted-foreground">No module bays.</p>
        ) : (
          <div className="grid gap-3">
            {bays.map((b) => (
              <FormCombobox
                key={b.name}
                label={b.name}
                value={picked[b.name] ?? null}
                onChange={(v) => setPicked((s) => ({ ...s, [b.name]: v }))}
                noneLabel="Cover"
                placeholder="Cover"
                searchPlaceholder="Search module types…"
                options={options}
              />
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!payload.data || !bays.length || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
