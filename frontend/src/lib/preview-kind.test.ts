// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  previewKind,
  rememberPreview,
  rememberedPreview,
  usePreviewKind,
} from "./preview-kind"

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("previewKind", () => {
  it("leads with the photo, then the model, then the icon", () => {
    expect(previewKind({ photo: "/a.png", model: { url: "/m" } })).toBe("photo")
    expect(previewKind({ photo: null, model: { url: "/m" } })).toBe("model")
    expect(previewKind({})).toBe("icon")
  })

  it("takes a remembered choice only when both exist", () => {
    expect(previewKind({ photo: "/a.png", model: {} }, "model")).toBe("model")
    expect(previewKind({ photo: "/a.png" }, "model")).toBe("photo")
    expect(previewKind({ model: {} }, "photo")).toBe("model")
    expect(previewKind({ photo: "/a.png", model: {} }, "icon")).toBe("photo")
  })
})

describe("remembered choice", () => {
  it("is kept per scope", () => {
    rememberPreview("panel", "model")
    expect(rememberedPreview("panel")).toBe("model")
    expect(rememberedPreview("device")).toBeNull()
  })

  it("ignores junk and storage that throws", () => {
    window.localStorage.setItem("danbyte.preview.device", "nonsense")
    expect(rememberedPreview("device")).toBeNull()
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(rememberedPreview("device")).toBeNull()
    expect(() => rememberPreview("device", "model")).not.toThrow()
  })

  it("the hook remembers a choice only when both exist", () => {
    const both = renderHook(() =>
      usePreviewKind("device", { photo: "/a.png", model: {} })
    )
    expect(both.result.current[0]).toBe("photo")
    act(() => both.result.current[1]("model"))
    expect(both.result.current[0]).toBe("model")
    expect(rememberedPreview("device")).toBe("model")

    window.localStorage.clear()
    const one = renderHook(() => usePreviewKind("panel", { model: {} }))
    act(() => one.result.current[1]("photo"))
    expect(one.result.current[0]).toBe("model")
    expect(rememberedPreview("panel")).toBeNull()
  })

  it("lets a pick of another view beat the model default, without remembering it", () => {
    window.localStorage.clear()
    const panel = renderHook(() =>
      usePreviewKind("device", { model: {}, other: true })
    )
    // No photo: the model leads...
    expect(panel.result.current[0]).toBe("model")
    // ...until the Rendered view is picked on the page.
    act(() => panel.result.current[1]("photo"))
    expect(panel.result.current[0]).toBe("photo")
    act(() => panel.result.current[1]("model"))
    expect(panel.result.current[0]).toBe("model")
    // Not carried to other devices: they still lead with their model.
    expect(rememberedPreview("device")).toBeNull()
  })
})
