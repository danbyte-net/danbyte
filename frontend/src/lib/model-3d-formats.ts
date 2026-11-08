/**
 * What the 3D model card accepts, and how each kind of file is read before
 * it is stored as one binary glTF (the only format the server keeps).
 * No three.js here - the converter itself lives under floorplan3d/.
 */

export type ModelFormat = "glb" | "gltf" | "step" | "iges" | "stl" | "obj"
export type ModelUnit = "mm" | "cm" | "m" | "in"
export type ModelUp = "y" | "z"
export type ModelFront = "+z" | "-z" | "+x" | "-x"
export type ModelFit = "auto" | "native"

/** The file input's accept list. */
export const MODEL_ACCEPT =
  ".glb,.gltf,.step,.stp,.iges,.igs,.stl,.obj,model/gltf-binary"

/** Triangles one model may carry when it is saved; more is offered a
 * simplification first. */
export const MODEL_TRIANGLE_CAP = 300_000

/** Metres per unit. */
export const UNIT_SCALE: Record<ModelUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
}

const EXT: Partial<Record<string, ModelFormat>> = {
  glb: "glb",
  gltf: "gltf",
  step: "step",
  stp: "step",
  iges: "iges",
  igs: "iges",
  stl: "stl",
  obj: "obj",
}

/** Native CAD formats nothing in the browser can read. */
const NATIVE_CAD = new Set([
  "sldprt",
  "sldasm",
  "slddrw",
  "ipt",
  "iam",
  "f3d",
  "f3z",
  "catpart",
  "catproduct",
  "prt",
  "asm",
  "par",
  "psm",
  "x_t",
  "x_b",
  "3dm",
  "skp",
  "dwg",
  "dxf",
  "fcstd",
  "blend",
])

export const NATIVE_CAD_MESSAGE = "Export it from GrabCAD as STEP or STL"

function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i < 0 ? "" : name.slice(i + 1).toLowerCase()
}

/** The format of a picked file, or the reason it can't be read. */
export function modelFormatOf(
  name: string
): { format: ModelFormat } | { error: string } {
  const ext = extOf(name)
  const format = EXT[ext]
  if (format) return { format }
  if (NATIVE_CAD.has(ext)) return { error: NATIVE_CAD_MESSAGE }
  return {
    error: "Use a .glb, .gltf, .step, .iges, .stl or .obj file.",
  }
}

/** What a format means by its numbers and which way is up, before anyone
 * says otherwise. CAD exchange formats are millimetres, Z up; glTF is
 * metres, Y up; OBJ is usually Y up and its units are anyone's guess. */
export function formatDefaults(format: ModelFormat): {
  unit: ModelUnit
  up: ModelUp
} {
  switch (format) {
    case "step":
    case "iges":
      return { unit: "mm", up: "z" }
    case "stl":
      return { unit: "mm", up: "z" }
    case "obj":
      return { unit: "mm", up: "y" }
    default:
      return { unit: "m", up: "y" }
  }
}

/** A unitless mesh's likely unit from its largest extent: anything a few
 * units across is metres; past ~10 it is millimetres (a 1U switch modelled
 * in metres is 0.48 across, in millimetres 482). */
export function guessUnit(maxExtent: number): ModelUnit {
  return maxExtent > 10 ? "mm" : "m"
}

/** Why a .gltf can't be stored as it is: one that points at files next to
 * it (.bin, textures) would lose them. Null when it is self-contained. */
export function gltfExternalRefs(json: unknown): string | null {
  if (!json || typeof json !== "object") return "Not a glTF file."
  const doc = json as {
    buffers?: ({ uri?: string } | null)[]
    images?: ({ uri?: string } | null)[]
  }
  for (const item of [...(doc.buffers ?? []), ...(doc.images ?? [])]) {
    if (item?.uri != null && !String(item.uri).startsWith("data:"))
      return "This .gltf uses separate files. Upload the .glb, or a self-contained .gltf."
  }
  return null
}

/** A size in bytes as the card shows it. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
