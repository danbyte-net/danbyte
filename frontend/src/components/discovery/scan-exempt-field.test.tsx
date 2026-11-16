// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { TooltipProvider } from "@/components/ui/tooltip"
import { installationLabel } from "./packages-tab"
import { ScanExemptField, useScanExemptDraft } from "./scan-exempt-field"

// "Do not scan" (#451): shown only while Discovery is on and to someone who
// may change the object; written through the exempt endpoint, once, only
// when it changed.

const { apiMock, me } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  me: { change: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", async (orig) => ({
  ...(await orig<object>()),
  useMe: () => ({ canDo: () => me.change }),
}))

afterEach(() => {
  cleanup()
  apiMock.mockReset()
  me.change = true
})

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  )
}

function discovery(active: boolean) {
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/discovery/status/") return { active }
    return { kind: "device", id: "d1", scan_exempt: true }
  })
}

const device = { id: "d1", scan_exempt: false }

describe("useScanExemptDraft", () => {
  it("is hidden while Discovery is off, for a new object, or without change", async () => {
    discovery(false)
    const off = renderHook(() => useScanExemptDraft("device", device), {
      wrapper,
    })
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(off.result.current.show).toBe(false)

    discovery(true)
    const fresh = renderHook(() => useScanExemptDraft("device", null), {
      wrapper,
    })
    expect(fresh.result.current.show).toBe(false)

    me.change = false
    const ro = renderHook(() => useScanExemptDraft("device", device), {
      wrapper,
    })
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/discovery/status/")
    )
    expect(ro.result.current.show).toBe(false)
  })

  it("writes through the exempt endpoint once, only when changed", async () => {
    discovery(true)
    const h = renderHook(() => useScanExemptDraft("device", device), {
      wrapper,
    })
    await waitFor(() => expect(h.result.current.show).toBe(true))
    await act(() => h.result.current.commit())
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/discovery/exempt/",
      expect.anything()
    )
    act(() => h.result.current.setValue(true))
    await act(() => h.result.current.commit())
    expect(apiMock).toHaveBeenCalledWith("/api/discovery/exempt/", {
      method: "POST",
      body: JSON.stringify({ kind: "device", id: "d1", exempt: true }),
    })
  })
})

describe("ScanExemptField", () => {
  it("labels the box tersely and names a hidden prefix generically", () => {
    const setValue = vi.fn()
    render(
      <ScanExemptField
        draft={{ show: true, value: false, setValue, commit: async () => {} }}
        via={{ id: null, cidr: null }}
      />,
      { wrapper }
    )
    fireEvent.click(screen.getByRole("checkbox", { name: /Do not scan/ }))
    expect(setValue).toHaveBeenCalledWith(true)
    expect(screen.getByText(/Exempt through/).textContent).toBe(
      "Exempt through a prefix"
    )
  })
})

describe("installationLabel", () => {
  it("names a server's variant and nothing for a client", () => {
    expect(installationLabel("Server")).toBe("Desktop Experience")
    expect(installationLabel("Server Core")).toBe("Server Core")
    expect(installationLabel("Client")).toBe("")
    expect(installationLabel("")).toBe("")
  })
})
