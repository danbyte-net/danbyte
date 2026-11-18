import { useSyncExternalStore } from "react"

/**
 * What a left-drag does in the 3D views: orbit about the pivot, or pan
 * (rotation locked). One choice for every 3D view, kept in this browser.
 * The camera rig reads it on each press (`readCameraMode`); toolbars show
 * and flip it (`useCameraMode`, `setCameraMode`).
 */
export type CameraMode = "orbit" | "pan"

export const CAMERA_MODE_KEY = "danbyte.camera3d.mode"

const listeners = new Set<() => void>()
let memo: CameraMode | null = null

function read(): CameraMode {
  try {
    return window.localStorage.getItem(CAMERA_MODE_KEY) === "pan"
      ? "pan"
      : "orbit"
  } catch {
    return "orbit"
  }
}

export function readCameraMode(): CameraMode {
  if (memo == null) memo = read()
  return memo
}

export function setCameraMode(mode: CameraMode): void {
  try {
    window.localStorage.setItem(CAMERA_MODE_KEY, mode)
  } catch {
    // Storage blocked - listeners still get the in-memory change below.
  }
  memo = mode
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useCameraMode(): CameraMode {
  return useSyncExternalStore(subscribe, readCameraMode, () => "orbit")
}

/** The 3D views' navigation, in one line (the room's hint). */
export const CAMERA_HINT =
  "Click sets the pivot · drag to orbit · right- or Shift-drag to pan · scroll to zoom · double-click to frame · F focus · 0 fit all · WASD move · Space/C up-down"
