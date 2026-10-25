// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Application, InstalledSoftware } from "@/lib/api"
import {
  applicationAncestors,
  buildApplicationColumns,
} from "./application-columns"
import { buildInstalledSoftwareColumns } from "./installed-software-columns"

// The application and installed-software column factories (#436).

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ me: {} }) }))

afterEach(cleanup)

const app = {
  id: "a",
  numid: 3,
  name: "checkout-api",
  slug: "checkout-api",
  path: "Payments › Checkout › checkout-api",
  depth: 2,
  parent: { id: "p", name: "Checkout" },
  manufacturer: null,
  eol_source: "",
  eol_product: "",
  eol: null,
  description: "",
  tags: [],
  custom_fields: {},
  install_count: 4,
  child_count: 0,
  created_at: "",
  updated_at: "",
} as Application

describe("application columns", () => {
  it("read the tree as the path before the name", () => {
    expect(applicationAncestors(app.path, app.name)).toBe("Payments › Checkout")
    expect(applicationAncestors("Solo", "Solo")).toBe("")
    const name = buildApplicationColumns().find((c) => c.id === "name")!
    render(<>{flexRender(name.cell, { row: { original: app } } as never)}</>)
    expect(screen.getByText("Payments › Checkout ›")).toBeTruthy()
    expect(screen.getByText("checkout-api").tagName).toBe("A")
  })

  it("hide parent, manufacturer, children and the product until asked", () => {
    const hidden = buildApplicationColumns()
      .filter((c) => c.meta?.defaultHidden)
      .map((c) => c.id)
    expect(hidden).toEqual(["parent", "manufacturer", "children", "eol"])
  })
})

describe("installed software columns", () => {
  const sw = {
    id: "s",
    application: {
      id: "a",
      name: "PostgreSQL",
      slug: "postgresql",
      path: "PostgreSQL",
    },
    device: null,
    virtual_machine: { id: "v", name: "vm-db" },
    version: "16.4",
    cycle: "16",
    eol: { status: "ending" },
  } as InstalledSoftware

  it("leave the end-of-life column out while the feature is off", () => {
    const ids = (eol: boolean) =>
      buildInstalledSoftwareColumns({ eol }).map((c) => c.id)
    expect(ids(false)).not.toContain("eol")
    expect(ids(true)).toContain("eol")
  })

  it("name the device or VM it runs on", () => {
    const parent = buildInstalledSoftwareColumns().find(
      (c) => c.id === "parent"
    )!
    render(<>{flexRender(parent.cell, { row: { original: sw } } as never)}</>)
    expect(screen.getByText("vm-db")).toBeTruthy()
  })
})
