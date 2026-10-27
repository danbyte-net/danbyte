// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ApplicationFlow } from "@/lib/api"
import { endKey, flowServiceLabel } from "@/lib/flows"
import { endPayload } from "@/components/application-flow-pane"
import {
  buildApplicationFlowColumns,
  flowEndText,
} from "./application-flow-columns"

// The application-flow column factory (#163) and the dialog's end payload.

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))

afterEach(cleanup)

const flow = {
  id: "f",
  name: "web to db",
  application: { id: "a", name: "Shop", slug: "shop", path: "Shop" },
  source: {
    kind: "ip",
    id: "i",
    label: "10.1.0.10",
    device: { id: "d", name: "web1" },
    vm: null,
  },
  destination: { kind: "any", id: null, label: "Any", device: null, vm: null },
  protocol: "tcp",
  protocol_display: "TCP",
  ports: "443, 8443",
  direction: "one-way",
  status: null,
  service: null,
  description: "",
} as unknown as ApplicationFlow

const cell = (id: string) => {
  const col = buildApplicationFlowColumns().find((c) => c.id === id)!
  render(<>{flexRender(col.cell, { row: { original: flow } } as never)}</>)
}

describe("application flow columns", () => {
  it("keep the canonical order and leave the application out on its page", () => {
    expect(buildApplicationFlowColumns().map((c) => c.id)).toEqual([
      "name",
      "application",
      "source",
      "destination",
      "service",
      "direction",
      "status",
      "linked_service",
      "description",
    ])
    const ids = buildApplicationFlowColumns({
      omit: ["application"],
      selection: true,
    }).map((c) => c.id)
    expect(ids).not.toContain("application")
    expect(ids[0]).toBe("select")
  })

  it("name an address's device after it, and read Any muted", () => {
    cell("source")
    expect(screen.getByText("10.1.0.10")).toBeTruthy()
    expect(screen.getByText("web1").tagName).toBe("A")
    cleanup()
    cell("destination")
    expect(screen.getByText("Any").tagName).toBe("SPAN")
    expect(flowEndText(flow.source)).toBe("10.1.0.10 web1")
  })

  it("read an end the caller may not view as a muted Hidden (#453)", () => {
    const hidden = {
      kind: "ip",
      id: null,
      label: "Hidden",
      device: null,
      vm: null,
      hidden: true,
    } as const
    const col = buildApplicationFlowColumns().find(
      (c) => c.id === "destination"
    )!
    const { container } = render(
      <>
        {flexRender(col.cell, {
          row: { original: { ...flow, destination: hidden } },
        } as never)}
      </>
    )
    expect(container.textContent).toBe("Hidden")
    expect(container.querySelector("a")).toBeNull()
    expect(container.querySelector(".text-muted-foreground")).toBeTruthy()
    expect(flowEndText(hidden)).toBe("Hidden")
    expect(endKey(hidden, "destination")).toBe("hidden:destination")
  })

  it("read the protocol and ports as one label", () => {
    cell("service")
    expect(screen.getByText("TCP 443, 8443")).toBeTruthy()
    expect(flowServiceLabel({ protocol: "icmp", ports: "" })).toBe("ICMP")
    expect(flowServiceLabel({ protocol: "tcp-udp", ports: "53" })).toBe(
      "TCP/UDP 53"
    )
  })

  it("hide the linked service until asked", () => {
    const hidden = buildApplicationFlowColumns()
      .filter((c) => c.meta?.defaultHidden)
      .map((c) => c.id)
    expect(hidden).toEqual(["linked_service"])
  })
})

describe("flow end payload", () => {
  it("sends the chosen kind and clears the others", () => {
    expect(endPayload("source", { kind: "prefix", id: "p" })).toEqual({
      source_ip_id: null,
      source_range_id: null,
      source_prefix_id: "p",
      source_any: false,
    })
    expect(endPayload("destination", { kind: "any", id: null })).toEqual({
      destination_ip_id: null,
      destination_range_id: null,
      destination_prefix_id: null,
      destination_any: true,
    })
  })

  it("sends nothing for a hidden end, so the server keeps it", () => {
    expect(
      endPayload("destination", { kind: "ip", id: null, hidden: true })
    ).toEqual({})
  })
})
