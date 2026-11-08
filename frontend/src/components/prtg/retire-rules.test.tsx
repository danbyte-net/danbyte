// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PrtgRetireRule } from "@/lib/api"
import { CONN, mountWithRouter } from "./prtg-test-utils"
import { PrtgRetireRules } from "./retire-rules"

// "When objects retire": the rule list with its status and tag badges, and
// the form that stores slugs and only lets a delete be automatic.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
}))

const RULE: PrtgRetireRule = {
  id: "r1",
  connection: "c1",
  name: "Retired",
  position: 0,
  statuses: ["retired"],
  tags: ["decom"],
  action: "delete",
  action_display: "Delete in PRTG",
  allow_auto: true,
  delete_any: false,
  created_at: "",
  updated_at: "",
}

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

let posts: { path: string; body: Record<string, unknown> }[] = []

function serve(rules: PrtgRetireRule[]) {
  posts = []
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST" || init?.method === "PATCH") {
      posts.push({ path, body: JSON.parse(String(init.body)) })
      return Promise.resolve(RULE)
    }
    if (path.startsWith("/api/prtg/retire-rules/")) return page(rules)
    if (path.startsWith("/api/statuses/"))
      return page([
        { id: "s1", name: "Retired", slug: "retired", color: "ef4444" },
        { id: "s2", name: "Active", slug: "active", color: "22c55e" },
      ])
    if (path.startsWith("/api/tags/"))
      return page([
        {
          id: 7,
          name: "Decom",
          slug: "decom",
          color: "f59e0b",
          text_color: "",
        },
      ])
    return page([])
  })
}

describe("PrtgRetireRules", () => {
  afterEach(() => {
    cleanup()
    apiMock.mockReset()
  })

  it("lists the rules with their statuses, tags and action", async () => {
    serve([RULE])
    mountWithRouter(() => <PrtgRetireRules connection={CONN} canManage />)
    expect(await screen.findByText("When objects retire")).toBeTruthy()
    expect(await screen.findByText("Delete in PRTG")).toBeTruthy()
    expect(screen.getByText("Automatic")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("Decom")).toBeTruthy())
    expect(screen.getAllByText("Retired").length).toBeGreaterThan(1)
  })

  it("adds a pause rule; only a delete can be automatic", async () => {
    serve([])
    mountWithRouter(() => <PrtgRetireRules connection={CONN} canManage />)
    fireEvent.click(await screen.findByRole("button", { name: /Add rule/ }))
    expect(screen.queryByText("Apply automatically")).toBeNull()
    fireEvent.change(screen.getByPlaceholderText("Retired"), {
      target: { value: "Gone" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }))
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0].path).toBe("/api/prtg/retire-rules/")
    expect(posts[0].body).toMatchObject({
      connection: "c1",
      name: "Gone",
      action: "pause",
      allow_auto: false,
      delete_any: false,
    })
  })
})
