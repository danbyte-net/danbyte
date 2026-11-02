// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  modelPlacement,
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

describe("modelPlacement", () => {
  it("joins a photo, else takes the right column, else nowhere", () => {
    expect(modelPlacement({ photo: "/a.png", model: {} })).toBe("panel")
    expect(modelPlacement({ photo: null, model: {} })).toBe("aside")
    expect(modelPlacement({ photo: "/a.png", model: null })).toBeNull()
    expect(modelPlacement({})).toBeNull()
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
})
