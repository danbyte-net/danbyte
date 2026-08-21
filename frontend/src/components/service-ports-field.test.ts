import { describe, expect, it } from "vitest"

import {
  parseServicePorts,
  servicePortsFromApi,
  servicePortsLabel,
} from "./service-ports-field"

describe("parseServicePorts", () => {
  it("keeps each protocol's ports apart - the thing one protocol field couldn't express", () => {
    const p = parseServicePorts({ tcp: "53, 443", udp: "53, 445" })
    expect(p.protocol_ports).toEqual({ tcp: [53, 443], udp: [53, 445] })
    // The legacy pair mirrors the first block for older readers.
    expect(p.protocol).toBe("tcp")
    expect(p.ports).toEqual([53, 443])
  })

  it("handles a single protocol exactly as before", () => {
    const p = parseServicePorts({ tcp: "443", udp: "" })
    expect(p.protocol_ports).toEqual({ tcp: [443] })
    expect(p.protocol).toBe("tcp")
    expect(p.errors.form).toBeNull()
  })

  it("mirrors UDP when that is the only protocol given", () => {
    const p = parseServicePorts({ tcp: "", udp: "514" })
    expect(p.protocol).toBe("udp")
    expect(p.ports).toEqual([514])
  })

  it("reports a bad token instead of silently dropping it", () => {
    const p = parseServicePorts({ tcp: "443, 70000, http", udp: "" })
    expect(p.errors.tcp).toContain("70000")
    expect(p.errors.tcp).toContain("http")
    expect(p.errors.udp).toBeNull()
  })

  it("asks for at least one port when both fields are empty", () => {
    const p = parseServicePorts({ tcp: "", udp: "  " })
    expect(p.errors.form).toBeTruthy()
    expect(p.protocol_ports).toEqual({})
  })

  it("accepts spaces or commas and drops duplicates", () => {
    expect(parseServicePorts({ tcp: "80 443,443", udp: "" }).ports).toEqual([
      80, 443,
    ])
  })
})

describe("servicePortsFromApi", () => {
  it("prefers the per-protocol map", () => {
    expect(
      servicePortsFromApi({ tcp: [53], udp: [53] }, "tcp", [53])
    ).toEqual({ tcp: "53", udp: "53" })
  })

  it("falls back to the single pair for a service saved before the split", () => {
    expect(servicePortsFromApi(undefined, "udp", [514])).toEqual({
      tcp: "",
      udp: "514",
    })
  })
})

describe("servicePortsLabel", () => {
  it("names every protocol on one line", () => {
    expect(servicePortsLabel({ tcp: [53, 443], udp: [53] }, "tcp", [53])).toBe(
      "TCP 53, 443 · UDP 53"
    )
  })

  it("reads like it always did for one protocol", () => {
    expect(servicePortsLabel(undefined, "tcp", [443])).toBe("TCP 443")
  })

  it("is empty when there are no ports at all", () => {
    expect(servicePortsLabel({}, "tcp", [])).toBe("")
  })
})
