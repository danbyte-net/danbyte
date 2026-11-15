import { Suspense, lazy, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api, deleteModel3D } from "@/lib/api"
import type {
  ImagePorts,
  ImagesSource,
  Model3DEffective,
  Model3DFit,
  Model3DFront,
  Model3DOwnerKind,
  Model3DUp,
  ModelPortsState,
  ModelScan,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ChoiceSelect,
  FIT_CHOICES,
  FRONT_CHOICES,
  UP_CHOICES,
} from "@/components/model-3d-choice"
import { InfoTip } from "@/components/ui/info-tip"
import { lazyChunk } from "@/lib/lazy-chunk"
import { imagesSourceLabel } from "@/lib/model-studio"
import {
  DeviceStudioDialog,
  DeviceTypeStudioDialog,
  ModelReferenceDialog,
} from "@/components/model-studio-dialog"

// three.js stays in the 3D chunk: the converter and the port editor load
// only when their dialog opens.
const ModelUpload = lazyChunk(
  () => import("@/components/floorplan3d/model-upload")
)
const ModelPortsEditor = lazy(
  () => import("@/components/floorplan3d/model-ports-editor")
)

/**
 * The "3D model" card on a device type's, a module type's and a device's
 * Overview: what the 3D room draws for it, and upload / replace / remove,
 * for the model and its optional far-distance copy. The model itself is
 * drawn once, by the Overview's viewer (model-viewer-card). A device shows
 * its type's model until it gets its own. "Anchors" sums up the model's
 * named nodes (bays, ports, LEDs) and what matched nothing in the type.
 * "Map ports" opens the editor that places the ports on a model that names
 * none itself (floorplan3d/model-ports-editor).
 */
export function Model3DCard({
  kind,
  id,
  own,
  farUrl = null,
  scan = null,
  inherited,
  fit,
  up,
  front,
  canEdit,
  queryKey,
  typeId,
  ownImagePorts,
  studio,
  deviceModel,
}: {
  kind: Model3DOwnerKind
  id: string
  /** The object's own model URL, or null. */
  own: string | null
  /** Its own model's far-distance copy, or null. */
  farUrl?: string | null
  /** What its own model's named nodes hold. */
  scan?: ModelScan | null
  /** A device's type's model, drawn while it has none of its own. */
  inherited?: {
    url: string
    up: Model3DUp
    front: Model3DFront
    fit?: Model3DFit
  } | null
  fit: Model3DFit
  up: Model3DUp
  front: Model3DFront
  canEdit: boolean
  /** The detail page's query, refreshed after a change. */
  queryKey: readonly unknown[]
  /** The device type (the object itself on a type): its templates and
   * photo ports feed the port mapping. */
  typeId?: string | null
  /** A device's own photo-port override. */
  ownImagePorts?: ImagePorts | null
  /** A device type's generated images (model-studio-dialog). */
  studio?: {
    pending: boolean
    generated: boolean
    reference: Record<string, string> | null
    /** Where each face came from (a pack, a browser render, by hand). */
    source?: ImagesSource | null
  }
  /** A device: what it draws, to render its own faces from. */
  deviceModel?: Model3DEffective | null
}) {
  const qc = useQueryClient()
  const [uploading, setUploading] = useState<"full" | "far" | null>(null)
  const [mapping, setMapping] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [referencing, setReferencing] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey })

  const patch = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api(`/api/${kind}/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
    onError: (e) => apiErrorToast(e),
  })
  const remove = useMutation({
    mutationFn: (lod: "full" | "far") => deleteModel3D(kind, id, lod),
    onSuccess: refresh,
    onError: (e) => apiErrorToast(e),
  })

  const shown = own
    ? { url: own, up, front, fit }
    : inherited
      ? {
          url: inherited.url,
          up: inherited.up,
          front: inherited.front,
          fit: inherited.fit ?? "auto",
        }
      : null
  // A module type's ports come from its model's anchors only.
  const mapsPorts = kind !== "module-types"
  const ports = useQuery({
    queryKey: ["model-ports", kind, id],
    queryFn: () => api<ModelPortsState>(`/api/${kind}/${id}/model-ports/`),
    enabled: !!shown && mapsPorts,
  })
  const drawn =
    kind === "devices" ? ports.data?.effective : ports.data?.model_ports
  const mappedN = drawn?.ports.length ?? 0
  const rows: KvRow[] = [
    {
      label: "Model",
      value: (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {own ? "Uploaded" : inherited ? "From device type" : dash}
          </span>
          {canEdit && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => setUploading("full")}
              >
                {own ? "Replace" : "Upload"}
              </Button>
              {own && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate("full")}
                >
                  {remove.isPending && remove.variables === "full"
                    ? "Removing…"
                    : "Remove"}
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ]
  if (own) {
    const choice = <T extends string>(
      label: string,
      field: string,
      value: T,
      choices: { value: T; label: string }[]
    ): KvRow => ({
      label,
      value: canEdit ? (
        <ChoiceSelect
          label={label}
          value={value}
          choices={choices}
          disabled={patch.isPending}
          onChange={(v) => patch.mutate({ [field]: v })}
        />
      ) : (
        (choices.find((c) => c.value === value)?.label ?? value)
      ),
    })
    rows.push(
      choice("Size", "model_3d_fit", fit, FIT_CHOICES),
      choice("Up axis", "model_3d_up", up, UP_CHOICES),
      choice("Front", "model_3d_front", front, FRONT_CHOICES),
      {
        label: "Far model",
        value: (
          <div className="flex flex-wrap items-center gap-2">
            <span>{farUrl ? "Uploaded" : dash}</span>
            {canEdit && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => setUploading("far")}
                >
                  {farUrl ? "Replace" : "Upload"}
                </Button>
                {farUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate("far")}
                  >
                    {remove.isPending && remove.variables === "far"
                      ? "Removing…"
                      : "Remove"}
                  </Button>
                )}
              </>
            )}
          </div>
        ),
      }
    )
    if (scan)
      rows.push({ label: "Anchors", value: <ScanSummary scan={scan} /> })
    if (studio) {
      const refN = Object.keys(studio.reference ?? {}).length
      if ((scan?.counts.bays ?? 0) > 0)
        rows.push({
          label: "Modules",
          value: (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {refN ? (
                  <>
                    <span className="num">{refN}</span> in the images
                  </>
                ) : (
                  "Covers"
                )}
              </span>
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => setReferencing(true)}
                >
                  Edit
                </Button>
              )}
            </div>
          ),
        })
      rows.push({
        label: "Images",
        value: (
          <div className="flex flex-wrap items-center gap-2">
            {studio.pending && <Badge variant="warning">Pending</Badge>}
            {studio.source !== undefined ? (
              <span>{imagesSourceLabel(studio.source) ?? dash}</span>
            ) : (
              !studio.pending && (
                <span>{studio.generated ? "Generated" : dash}</span>
              )
            )}
            {studio.source?.pack?.note && (
              <InfoTip>{studio.source.pack.note}</InfoTip>
            )}
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => setGenerating(true)}
              >
                Generate images
              </Button>
            )}
          </div>
        ),
      })
    }
  }
  if (deviceModel && canEdit)
    rows.push({
      label: "Faces",
      value: (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => setGenerating(true)}
        >
          Render faces
        </Button>
      ),
    })
  // Ports the model's own `port:` nodes place: nothing to map by hand.
  const anchored =
    (scan?.counts.ports ?? 0) > 0 || ports.data?.source === "anchors"
  if (shown && mapsPorts) {
    rows.push({
      label: "Ports",
      value: (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {mappedN ? (
              <>
                <span className="num">{mappedN}</span>{" "}
                {anchored ? "on the model" : "mapped"}
                {ports.data?.source === "type" ? " · from device type" : ""}
              </>
            ) : (
              dash
            )}
          </span>
          {canEdit && typeId && !anchored && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => setMapping(true)}
            >
              Map ports
            </Button>
          )}
        </div>
      ),
    })
  }

  return (
    <>
      <KvCard title="3D model" rows={rows} />
      <Dialog
        open={uploading !== null}
        onOpenChange={(o) => !o && setUploading(null)}
      >
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {uploading === "far"
                ? farUrl
                  ? "Replace far model"
                  : "Upload far model"
                : own
                  ? "Replace 3D model"
                  : "Upload 3D model"}
            </DialogTitle>
          </DialogHeader>
          {uploading && (
            <Suspense fallback={<Loading />}>
              <ModelUpload
                kind={kind}
                id={id}
                lod={uploading}
                // A replaced model may keep the mapping when it matches.
                portsBounds={
                  own && uploading === "full"
                    ? (ports.data?.model_ports?.bounds ?? null)
                    : null
                }
                onCancel={() => setUploading(null)}
                onSaved={() => {
                  // A new model on a type: offer its images straight away.
                  if (studio && uploading === "full") setGenerating(true)
                  setUploading(null)
                  void refresh()
                  void ports.refetch()
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={mapping} onOpenChange={setMapping}>
        <DialogContent size="6xl">
          <DialogHeader>
            <DialogTitle>Map ports</DialogTitle>
          </DialogHeader>
          {mapping && shown && typeId && (
            <Suspense fallback={<Loading />}>
              <ModelPortsEditor
                kind={kind as "device-types" | "devices"}
                id={id}
                typeId={typeId}
                url={shown.url}
                up={shown.up}
                front={shown.front}
                fit={shown.fit}
                ownImagePorts={ownImagePorts}
                onDone={(saved) => {
                  setMapping(false)
                  if (saved) {
                    void ports.refetch()
                    void refresh()
                  }
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
      {studio && (
        <>
          <DeviceTypeStudioDialog
            deviceTypeId={id}
            open={generating}
            onOpenChange={setGenerating}
          />
          <ModelReferenceDialog
            deviceTypeId={id}
            open={referencing}
            onOpenChange={setReferencing}
          />
        </>
      )}
      {deviceModel && (
        <DeviceStudioDialog
          deviceId={id}
          model={deviceModel}
          open={generating}
          onOpenChange={setGenerating}
        />
      )}
    </>
  )
}

/** "7 bays, 53 ports, 54 LEDs", with the mismatches on hover. */
function ScanSummary({ scan }: { scan: ModelScan }) {
  const n = scan.warnings.length
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="num">{scan.summary}</span>
      {n > 0 && (
        <HoverCard openDelay={100} closeDelay={60}>
          <HoverCardTrigger asChild>
            <button type="button" className="inline-flex">
              <Badge variant="warning">
                {n === 1 ? "1 mismatch" : `${n} mismatches`}
              </Badge>
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="w-96 text-xs">
            <ul className="list-disc space-y-1 pl-4">
              {scan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
}
