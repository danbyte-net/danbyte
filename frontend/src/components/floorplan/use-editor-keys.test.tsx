// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"

import { useEditorKeys } from "./use-editor-keys"
import type { PlanEditState } from "./use-plan-edit-state"
import type { PlanViewPrefs } from "./use-plan-view-prefs"
import type { StructureEdits } from "./use-structure-edits"
import type { TileEdits } from "./use-tile-edits"

// P opens the Place picker: in Edit, and from View for those who may edit
// (Edit comes on first), never for a reader or in the 3D room.

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("@/components/hidden-objects", async (orig) => ({
  ...(await orig<object>()),
  useHideKeys: () => {},
}))
vi.mock("@/components/topology/view-document", () => ({
  useDocumentKeys: () => {},
}))

afterEach(cleanup)

const ed = {
  tiles: [],
  shapes: [],
  multiSel: new Set(),
  selectedId: null,
  selectedShapeId: null,
  tool: "select",
  mode: "layout",
} as unknown as PlanEditState

function keys(over: {
  canEdit: boolean
  canToggleEdit: boolean
  view3d?: boolean
}) {
  const onPlaceKey = vi.fn()
  const onToggleEdit = vi.fn()
  renderHook(() =>
    useEditorKeys({
      view3d: false,
      ...over,
      onPlaceKey,
      onToggleEdit,
      traceParam: undefined,
      tracedRef: { current: null },
      plan: { layout_mode: "grid" } as FloorPlan,
      ed,
      edits: {} as TileEdits,
      structure: {} as StructureEdits,
      prefs: { hidden: {}, setHiddenPref: vi.fn() } as unknown as PlanViewPrefs,
      hiddenTileIds: new Set(),
      closePopover: vi.fn(),
    })
  )
  fireEvent.keyDown(window, { key: "p" })
  return { onPlaceKey, onToggleEdit }
}

describe("the P key", () => {
  it("opens the picker in Edit", () => {
    const k = keys({ canEdit: true, canToggleEdit: true })
    expect(k.onPlaceKey).toHaveBeenCalledTimes(1)
    expect(k.onToggleEdit).not.toHaveBeenCalled()
  })

  it("in View, switches an editor to Edit and opens it", () => {
    const k = keys({ canEdit: false, canToggleEdit: true })
    expect(k.onToggleEdit).toHaveBeenCalledWith(true)
    expect(k.onPlaceKey).toHaveBeenCalledTimes(1)
  })

  it("does nothing for a reader, or in 3D", () => {
    expect(
      keys({ canEdit: false, canToggleEdit: false }).onPlaceKey
    ).not.toHaveBeenCalled()
    expect(
      keys({ canEdit: true, canToggleEdit: true, view3d: true }).onPlaceKey
    ).not.toHaveBeenCalled()
  })
})
