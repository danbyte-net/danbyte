import { beforeEach, describe, expect, it, vi } from "vitest"

import { COPY_FAILED, copyWithToast } from "./clipboard"

// vi.mock is hoisted above the imports, so the helper gets this toast.
const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock("sonner", () => ({ toast: toastMock }))

// No window in the node environment, so copyText reports failure; a stubbed
// secure-context clipboard makes it succeed.
function stubClipboard(writeText: (v: string) => Promise<void>) {
  vi.stubGlobal("window", { isSecureContext: true })
  vi.stubGlobal("navigator", { clipboard: { writeText } })
}

describe("copyWithToast", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
  })

  it("says the one shared failure when the copy doesn't land", async () => {
    expect(COPY_FAILED).toBe("Couldn't copy")
    expect(await copyWithToast("10.0.0.1", "Copied 10.0.0.1")).toBe(false)
    expect(toastMock.error).toHaveBeenCalledWith("Couldn't copy")
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("toasts the caller's success text when it lands", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    stubClipboard(writeText)
    expect(await copyWithToast("10.0.0.1", "Copied 10.0.0.1")).toBe(true)
    expect(writeText).toHaveBeenCalledWith("10.0.0.1")
    expect(toastMock.success).toHaveBeenCalledWith("Copied 10.0.0.1")
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it("stays quiet on success when the caller shows its own state", async () => {
    stubClipboard(() => Promise.resolve())
    expect(await copyWithToast("x")).toBe(true)
    expect(toastMock.success).not.toHaveBeenCalled()
  })
})
