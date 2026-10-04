// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError, apiErrorMessage, ioExportFile } from "@/lib/api"

// A selection is exported by POSTing its ids (#176): in a GET's query string
// a few hundred UUIDs pass the proxy's 8 KB request-line limit.

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT"
})

function stubFetch(res: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(res)
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("ioExportFile", () => {
  it("posts the ids in the body with the CSRF token", async () => {
    document.cookie = "csrftoken=tok123"
    const fetchMock = stubFetch(
      new Response("id\n", {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="vlan.csv"',
        },
      })
    )
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`)

    const out = await ioExportFile("vlan", { fmt: "csv", ids })

    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/io/vlan/export/")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({ fmt: "csv", ids })
    expect(new Headers(init?.headers).get("X-CSRFToken")).toBe("tok123")
    expect(out.filename).toBe("vlan.csv")
    expect(await out.blob.text()).toBe("id\n")
  })

  it("falls back to slug.fmt without a Content-Disposition", async () => {
    stubFetch(new Response("[]"))
    const out = await ioExportFile("prefix", { fmt: "json", ids: ["a"] })
    expect(out.filename).toBe("prefix.json")
  })

  it("throws the server's refusal as an ApiError", async () => {
    stubFetch(
      new Response(JSON.stringify({ ids: "One of the ids is not valid." }), {
        status: 400,
      })
    )
    const err = await ioExportFile("vlan", { fmt: "csv", ids: ["x"] }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
    expect(apiErrorMessage(err)).toBe("ids: One of the ids is not valid.")
  })
})
