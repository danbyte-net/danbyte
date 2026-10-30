// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { UpdatePrompt } from "./update-prompt"

const fetchMock = vi.fn(
  async () =>
    new Response('<script src="/assets/index-abc.js"></script>', {
      status: 200,
    })
)

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  document.head.innerHTML = '<script src="/assets/index-abc.js"></script>'
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const focus = () =>
  act(async () => {
    window.dispatchEvent(new Event("focus"))
  })

describe("UpdatePrompt", () => {
  it("does not refetch the page it was just served, nor on every focus", async () => {
    render(<UpdatePrompt />)
    await focus()
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(61_000)
    })
    await focus()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith("/", expect.anything())
    await focus()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
