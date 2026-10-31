import { Suspense, lazy, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api, deleteModel3D } from "@/lib/api"
import type {
  ImagePorts,
  Model3DFit,
  Model3DFront,
  Model3DUp,
  ModelPortsState,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { Button } from "@/components/ui/button"
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

// three.js stays in the 3D chunk: the preview and the converter load only
// when the card has a model to show or the upload dialog opens.
const ModelPreview = lazy(
  () => import("@/components/floorplan3d/model-preview")
)
const ModelUpload = lazy(() => import("@/components/floorplan3d/model-upload"))
const ModelPortsEditor = lazy(
  () => import("@/components/floorplan3d/model-ports-editor")
)

/**
 * The "3D model" card on a device type's and a device's Overview: what the
 * 3D room draws for it, a small turntable of it, and upload / replace /
 * remove. A device shows its type's model until it gets its own. "Map
 * ports" opens the editor that places the ports on the model
 * (floorplan3d/model-ports-editor).
 */
export function Model3DCard({
  kind,
  id,
  own,
  inherited,
  fit,
  up,
  front,
  canEdit,
  queryKey,
  typeId,
  ownImagePorts,
}: {
  kind: "device-types" | "devices"
  id: string
  /** The object's own model URL, or null. */
  own: string | null
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
}) {
  const qc = useQueryClient()
  const [uploading, setUploading] = useState(false)
  const [mapping, setMapping] = useState(false)
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
    mutationFn: () => deleteModel3D(kind, id),
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
  const ports = useQuery({
    queryKey: ["model-ports", kind, id],
    queryFn: () => api<ModelPortsState>(`/api/${kind}/${id}/model-ports/`),
    enabled: !!shown,
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
                onClick={() => setUploading(true)}
              >
                {own ? "Replace" : "Upload"}
              </Button>
              {own && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? "Removing…" : "Remove"}
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
      choice("Front", "model_3d_front", front, FRONT_CHOICES)
    )
  }
  if (shown) {
    rows.push({
      label: "Ports",
      value: (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {mappedN ? (
              <>
                <span className="num">{mappedN}</span> mapped
                {ports.data?.source === "type" ? " · from device type" : ""}
              </>
            ) : (
              dash
            )}
          </span>
          {canEdit && typeId && (
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
    rows.push({
      label: "Preview",
      value: (
        <Suspense fallback={<Loading />}>
          <ModelPreview url={shown.url} up={shown.up} front={shown.front} />
        </Suspense>
      ),
    })
  }

  return (
    <>
      <KvCard title="3D model" rows={rows} />
      <Dialog open={uploading} onOpenChange={setUploading}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {own ? "Replace 3D model" : "Upload 3D model"}
            </DialogTitle>
          </DialogHeader>
          {uploading && (
            <Suspense fallback={<Loading />}>
              <ModelUpload
                kind={kind}
                id={id}
                // A replaced model may keep the mapping when it matches.
                portsBounds={
                  own ? (ports.data?.model_ports?.bounds ?? null) : null
                }
                onCancel={() => setUploading(false)}
                onSaved={() => {
                  setUploading(false)
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
                kind={kind}
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
    </>
  )
}
