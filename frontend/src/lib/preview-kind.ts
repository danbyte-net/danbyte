import { useState } from "react"

/**
 * Which picture an object leads with - on a device's Overview and in the
 * floor plan's detail panel: its rack-face photo when it has one, else its
 * 3D model, else its icon. When it has both a photo and a model, the
 * reader's last choice for that kind of view wins (kept in this browser).
 */

export type PreviewKind = "photo" | "model" | "icon"

/** Where a remembered choice applies: a device's Overview, or the floor
 * plan's detail panel. */
export type PreviewScope = "device" | "panel"

const KEY = (scope: PreviewScope) => `danbyte.preview.${scope}`

export function previewKind(
  obj: { photo?: unknown; model?: unknown },
  remembered?: PreviewKind | null
): PreviewKind {
  const photo = !!obj.photo
  const model = !!obj.model
  if (photo && model && (remembered === "photo" || remembered === "model"))
    return remembered
  if (photo) return "photo"
  if (model) return "model"
  return "icon"
}

/** The remembered choice, or null - also when storage is unavailable. */
export function rememberedPreview(scope: PreviewScope): PreviewKind | null {
  try {
    const v = window.localStorage.getItem(KEY(scope))
    return v === "photo" || v === "model" ? v : null
  } catch {
    return null
  }
}

export function rememberPreview(scope: PreviewScope, kind: PreviewKind) {
  try {
    window.localStorage.setItem(KEY(scope), kind)
  } catch {
    // Private window or blocked storage: the choice lasts this view only.
  }
}

/**
 * The preview to show and a setter that remembers the reader's choice -
 * only meaningful when both a photo and a model exist, so it is only
 * remembered then.
 */
export function usePreviewKind(
  scope: PreviewScope,
  obj: { photo?: unknown; model?: unknown; other?: unknown }
): [PreviewKind, (kind: PreviewKind) => void] {
  const [chosen, setChosen] = useState<PreviewKind | null>(() =>
    rememberedPreview(scope)
  )
  // Picked on this page: wins whenever the model has another view beside it
  // (a photo, or `other` - e.g. the Panel's Rendered schematic), so a click
  // on that view is never overruled by the default.
  const [picked, setPicked] = useState<PreviewKind | null>(null)
  const kind =
    picked && obj.model && (obj.photo || obj.other)
      ? picked
      : previewKind(obj, chosen)
  const set = (k: PreviewKind) => {
    setPicked(k)
    setChosen(k)
    // Only a photo-vs-model choice is carried to other objects: without a
    // photo the model stays the default lead.
    if (obj.photo && obj.model) rememberPreview(scope, k)
  }
  return [kind, set]
}
