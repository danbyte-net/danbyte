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
  obj: { photo?: unknown; model?: unknown }
): [PreviewKind, (kind: PreviewKind) => void] {
  const [chosen, setChosen] = useState<PreviewKind | null>(() =>
    rememberedPreview(scope)
  )
  const kind = previewKind(obj, chosen)
  const set = (k: PreviewKind) => {
    setChosen(k)
    if (obj.photo && obj.model) rememberPreview(scope, k)
  }
  return [kind, set]
}
