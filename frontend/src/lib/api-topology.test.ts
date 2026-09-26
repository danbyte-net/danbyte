import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fetchTopology, postTopology } from "./api"

type Call = { url: string; init: RequestInit }
const calls: Call[] = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ nodes: [], edges: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchTopology", () => {
  it("GETs a filtered map with CSV lists and 1/0 flags", async () => {
    await fetchTopology({
      site: "s1",
      role: "",
      depth: 2,
      collapse_panels: false,
      include: ["card", "link_ips"],
      card_fields: ["primary_ip", "serial"],
    })
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url, "http://x")
    expect(url.pathname).toBe("/api/topology/")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      site: "s1",
      depth: "2",
      collapse_panels: "0",
      include: "card,link_ips",
      card_fields: "primary_ip,serial",
    })
    expect(calls[0].init.method).toBeUndefined()
  })

  it("POSTs once a device set is given, even an empty one", async () => {
    await fetchTopology({ devices: [], include: ["photo"] })
    expect(calls[0].url).toBe("/api/topology/")
    expect(calls[0].init.method).toBe("POST")
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      devices: [],
      include: ["photo"],
    })
  })
})

describe("postTopology", () => {
  it("sends the query as a JSON body", async () => {
    const devices = Array.from({ length: 300 }, (_, i) => `d${i}`)
    const g = await postTopology({ devices, collapse_panels: true })
    expect(g).toEqual({ nodes: [], edges: [] })
    const { init } = calls[0]
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json"
    )
    expect(JSON.parse(init.body as string)).toEqual({
      devices,
      collapse_panels: true,
    })
  })
})
