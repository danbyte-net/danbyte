import { useCallback, useState } from "react"

/** Where this browser keeps whether the floor-plan editor opens in Edit. */
export const EDIT_MODE_KEY = "floorplan:edit"

function readStored(): boolean {
  try {
    return window.localStorage.getItem(EDIT_MODE_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * View or Edit. Every plan opens in View - a clean canvas to look at, click
 * and export - unless this browser last left the editor in Edit. Only a
 * user who may change floor plans gets Edit; for anyone else it is always
 * View, whatever the browser remembers.
 */
export function useEditMode(canEdit: boolean) {
  const [edit, setEditState] = useState(readStored)
  const setEdit = useCallback((on: boolean) => {
    setEditState(on)
    try {
      window.localStorage.setItem(EDIT_MODE_KEY, on ? "1" : "0")
    } catch {
      // Storage off (private window): the choice lasts for this page.
    }
  }, [])
  return { editing: canEdit && edit, setEdit }
}
