import { useCallback, useState } from "react"

import { isLineColorBy } from "@/components/site-map/line-style"
import type { LineColorBy } from "@/components/site-map/line-style"

// The site map's line display prefs (#246): Color by and the Speed labels,
// remembered per browser beside its other display prefs (`site-map:*`).

export const COLOR_BY_KEY = "site-map:color-by"
export const SPEED_LABELS_KEY = "site-map:speed-labels"

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private window or blocked storage: the choice lasts this visit */
  }
}

/** Color by - Type until picked - and the Speed labels, on until turned
 * off. */
export function useLineDisplay(): {
  colorBy: LineColorBy
  setColorBy: (v: LineColorBy) => void
  speedLabels: boolean
  setSpeedLabels: (v: boolean) => void
} {
  const [colorBy, setColorByState] = useState<LineColorBy>(() => {
    const v = read(COLOR_BY_KEY)
    return isLineColorBy(v) ? v : "type"
  })
  const [speedLabels, setSpeedLabelsState] = useState(
    () => read(SPEED_LABELS_KEY) !== "off"
  )
  const setColorBy = useCallback((v: LineColorBy) => {
    write(COLOR_BY_KEY, v)
    setColorByState(v)
  }, [])
  const setSpeedLabels = useCallback((v: boolean) => {
    write(SPEED_LABELS_KEY, v ? "on" : "off")
    setSpeedLabelsState(v)
  }, [])
  return { colorBy, setColorBy, speedLabels, setSpeedLabels }
}
