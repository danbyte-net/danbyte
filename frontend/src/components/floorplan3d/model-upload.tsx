import { useEffect, useRef, useState } from "react"
import { Vector3 } from "three"
import type * as THREE from "three"

import { Button } from "@/components/ui/button"
import { Loading } from "@/components/loading"
import { Badge } from "@/components/ui/badge"
import {
  ChoiceSelect,
  UNIT_CHOICES,
  UP_CHOICES,
} from "@/components/model-3d-choice"
import { apiErrorToast } from "@/lib/api-toast"
import { uploadModel3D } from "@/lib/api"
import {
  MODEL_ACCEPT,
  MODEL_TRIANGLE_CAP,
  formatBytes,
  formatDefaults,
  guessUnit,
  modelFormatOf,
} from "@/lib/model-3d-formats"
import type { ModelFormat, ModelUnit, ModelUp } from "@/lib/model-3d-formats"

import ModelPreview from "./model-preview"
import {
  boundsOf,
  disposeGroup,
  exportGlb,
  loadSource,
  maxExtent,
  prepare,
  simplify,
  triangleCount,
} from "./model-convert"

/**
 * The upload dialog's body: pick a file (GLB/glTF, or STEP, IGES, STL, OBJ
 * from GrabCAD and friends), see it converted - metres, Y up, merged per
 * material - with its triangles and stored size, simplify it when it is
 * too detailed, and save the binary glTF. Default export for `lazy()`:
 * three.js and the converter load only when the dialog opens.
 */
export default function ModelUpload({
  kind,
  id,
  onSaved,
  onCancel,
}: {
  kind: "device-types" | "devices"
  id: string
  onSaved: (data: unknown) => void
  onCancel: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState<ModelFormat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<THREE.Group | null>(null)
  const [unit, setUnit] = useState<ModelUnit>("m")
  const [up, setUp] = useState<ModelUp>("y")
  const [simplified, setSimplified] = useState(false)
  const [group, setGroup] = useState<THREE.Group | null>(null)
  const [glb, setGlb] = useState<ArrayBuffer | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const pick = async (f: File) => {
    setError(null)
    setSource(null)
    setGroup(null)
    setGlb(null)
    setSimplified(false)
    setFile(f)
    const fmt = modelFormatOf(f.name)
    if ("error" in fmt) {
      setError(fmt.error)
      return
    }
    setFormat(fmt.format)
    setBusy(
      fmt.format === "step" || fmt.format === "iges"
        ? "Converting…"
        : "Reading…"
    )
    try {
      const src = await loadSource(f, fmt.format)
      const d = formatDefaults(fmt.format)
      // STL and OBJ carry no unit: a part tens of units across is mm.
      const u =
        fmt.format === "stl" || fmt.format === "obj"
          ? guessUnit(maxExtent(src))
          : d.unit
      setUnit(u)
      setUp(d.up)
      setSource(src)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be read.")
    } finally {
      setBusy(null)
    }
  }

  // Units, axis or the source changed: rebuild the converted scene.
  useEffect(() => {
    if (!source) return
    const g = prepare(source, unit, up)
    setSimplified(false)
    setGroup(g)
    return () => disposeGroup(g)
  }, [source, unit, up])

  // The stored file, so its size shows before saving. A .glb left as it
  // was (metres, Y up, not simplified) is stored exactly as picked.
  useEffect(() => {
    if (!group || !file) return
    let live = true
    setGlb(null)
    const keep = format === "glb" && unit === "m" && up === "y" && !simplified
    ;(keep ? file.arrayBuffer() : exportGlb(group))
      .then((b) => live && setGlb(b))
      .catch(() => live && setError("The model could not be converted."))
    return () => {
      live = false
    }
  }, [group, file, format, unit, up, simplified])

  const triangles = group ? triangleCount(group) : 0
  const tooMany = triangles > MODEL_TRIANGLE_CAP

  const doSimplify = async () => {
    if (!group) return
    setBusy("Simplifying…")
    try {
      const g = await simplify(group, MODEL_TRIANGLE_CAP)
      setGroup(g)
      setSimplified(true)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!glb) return
    setSaving(true)
    try {
      const data = await uploadModel3D(
        kind,
        id,
        new Blob([glb], { type: "model/gltf-binary" }),
        // Converted files are metres, Y up, front +Z already.
        { up: "y", front: "+z", fit: "auto" }
      )
      onSaved(data)
    } catch (e) {
      apiErrorToast(e, "Couldn't save the model.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-3 text-[13px]">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={MODEL_ACCEPT}
          className="hidden"
          aria-label="3D model file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void pick(f)
            e.target.value = ""
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={!!busy || saving}
        >
          Choose file
        </Button>
        <span className="min-w-0 truncate text-muted-foreground">
          {file ? file.name : "GLB, glTF, STEP, IGES, STL or OBJ"}
        </span>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {busy && <Loading />}
      {group && !busy && (
        <>
          <ModelPreview object={group} className="h-64" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-muted-foreground">Units</span>
              <ChoiceSelect
                label="Units"
                value={unit}
                choices={UNIT_CHOICES}
                onChange={setUnit}
              />
            </label>
            <label className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-muted-foreground">Up axis</span>
              <ChoiceSelect
                label="Up axis"
                value={up}
                choices={UP_CHOICES}
                onChange={setUp}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span className="num">{triangles.toLocaleString()} triangles</span>
            <span>·</span>
            <span className="num">
              {glb ? formatBytes(glb.byteLength) : "…"}
            </span>
            <span>·</span>
            <ModelSize group={group} />
            {tooMany && <Badge variant="warning">Too detailed</Badge>}
          </div>
          {tooMany && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                Over the {MODEL_TRIANGLE_CAP.toLocaleString()} triangle cap.
              </span>
              <Button size="sm" variant="outline" onClick={doSimplify}>
                Simplify
              </Button>
            </div>
          )}
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={!glb || tooMany || !!busy || saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  )
}

/** The converted model's size, so a wrong unit shows at a glance. */
function ModelSize({ group }: { group: THREE.Group }) {
  const s = boundsOf(group).getSize(new Vector3())
  const f = (v: number) =>
    v >= 1 ? `${v.toFixed(2)} m` : `${Math.round(v * 1000)} mm`
  return <span className="num">{`${f(s.x)} × ${f(s.y)} × ${f(s.z)}`}</span>
}
