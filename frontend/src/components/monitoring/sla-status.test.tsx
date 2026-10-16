// @vitest-environment jsdom
import type { ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { STATUS_BATCH } from "./bulk-status"
import { useSlaStatus } from "./sla-status"

// A list longer than the SLA endpoint's bound used to get a 400 and an empty
// column (#430): the ids go in batches and the answers merge.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe("useSlaStatus", () => {
  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation((_path, init) => {
      const ids = JSON.parse(String(init?.body)).ids as string[]
      return Promise.resolve({
        frame: "30d",
        results: { [ids[0]]: { sla: [], lowest: null, availability: 99.9 } },
      })
    })
  })

  it("batches past the server's bound and merges the answers", async () => {
    const ids = Array.from({ length: STATUS_BATCH + 1 }, (_, i) => `p${i}`)
    const { result } = renderHook(() => useSlaStatus("prefix", ids), {
      wrapper,
    })
    await waitFor(() => expect(result.current.entries).toBeDefined())
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(Object.keys(result.current.entries ?? {}).sort()).toEqual(
      ["p0", `p${STATUS_BATCH}`].sort()
    )
    expect(result.current.frame).toBe("30d")
  })
})
