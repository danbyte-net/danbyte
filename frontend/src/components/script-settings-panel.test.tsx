// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Script } from "@/lib/api"
import { ScriptSettingsPanel } from "./script-settings-panel"

// A script that runs as its owner (or on a schedule, which does) lends the
// owner's identity, so only the owner or a holder of trust may widen its
// token from read only to read and write (#317). Narrowing stays open.

const { meMock } = vi.hoisted(() => ({
  meMock: { username: "bob", trust: false },
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (_m: string, verb: string) => verb !== "trust" || meMock.trust,
    me: { username: meMock.username },
  }),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

function script(patch: Partial<Script>): Script {
  return {
    id: "s1",
    name: "Sync",
    slug: "sync",
    description: "",
    language: "python",
    source: "",
    params_schema: [],
    token_scope: "read",
    timeout_seconds: 300,
    trusted: false,
    run_as: "owner",
    owner: "u1",
    owner_name: "alice",
    visibility: "owner",
    shared_users: [],
    shared_groups: [],
    schedule_enabled: false,
    schedule_params: {},
    last_run_at: null,
    last_run_time: null,
    last_run_status: null,
    run_count: 0,
    enabled: true,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...patch,
  } as Script
}

function scopeOptions(s: Script): string[] {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ScriptSettingsPanel script={s} canEdit canEditCode />
    </QueryClientProvider>
  )
  // API access is the first select in the card.
  fireEvent.click(screen.getAllByRole("combobox")[0])
  return screen.getAllByRole("option").map((o) => o.textContent)
}

afterEach(() => {
  cleanup()
  meMock.username = "bob"
  meMock.trust = false
})

describe("ScriptSettingsPanel API access", () => {
  it("does not offer read and write to others on a script run as its owner", () => {
    expect(scopeOptions(script({}))).toEqual(["Read only"])
  })

  it("does not offer it on a scheduled script either", () => {
    expect(
      scopeOptions(script({ run_as: "caller", schedule_enabled: true }))
    ).toEqual(["Read only"])
  })

  it("offers it to the owner and to a holder of trust", () => {
    meMock.username = "alice"
    expect(scopeOptions(script({}))).toEqual(["Read and write", "Read only"])
    cleanup()
    meMock.username = "bob"
    meMock.trust = true
    expect(scopeOptions(script({}))).toEqual(["Read and write", "Read only"])
  })

  it("offers it when the script runs as the caller", () => {
    expect(scopeOptions(script({ run_as: "caller" }))).toEqual([
      "Read and write",
      "Read only",
    ])
  })

  it("keeps it on a script that already has it, so it can be narrowed", () => {
    expect(scopeOptions(script({ token_scope: "full" }))).toEqual([
      "Read and write",
      "Read only",
    ])
  })
})
