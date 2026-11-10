// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { CpeSearchResult } from "@/lib/api"
import {
  CPE_SEARCH_DEBOUNCE_MS,
  CpePicker,
  cpeOptions,
  remoteNote,
} from "./cpe-picker"
import { coverageLine, sbomIdentifier } from "./mapping-card"

// The mapping picker (#451): typed name first, then the store, then NVD,
// one row per product and only the parts the subject takes; a terse line
// says when NVD was not asked; the coverage line under each mapping.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

const XE = {
  part: "o",
  vendor: "cisco",
  product: "ios_xe",
  cpe: "cpe:2.3:o:cisco:ios_xe",
}

function result(patch: Partial<CpeSearchResult> = {}): CpeSearchResult {
  return {
    query: "ios xe",
    typed: null,
    local: [{ ...XE, cves: 560 }],
    remote: [
      { ...XE, example_title: "Cisco IOS XE 17.9.4a", names: 812 },
      {
        part: "a",
        vendor: "cisco",
        product: "ios_xe_sd-wan",
        cpe: "cpe:2.3:a:cisco:ios_xe_sd-wan",
        names: 4,
      },
      {
        part: "h",
        vendor: "cisco",
        product: "catalyst_9300",
        cpe: "cpe:2.3:h:cisco:catalyst_9300",
        names: 1,
      },
    ],
    remote_status: "ok",
    remote_error: "",
    ...patch,
  }
}

describe("cpeOptions", () => {
  it("dedups by name, store before NVD, and keeps the subject's parts", () => {
    const rows = cpeOptions(result(), ["o", "a"])
    expect(rows.map((r) => [r.cpe, r.from])).toEqual([
      ["cpe:2.3:o:cisco:ios_xe", "local"],
      ["cpe:2.3:a:cisco:ios_xe_sd-wan", "remote"],
    ])
    expect(cpeOptions(result(), ["h"]).map((r) => r.cpe)).toEqual([
      "cpe:2.3:h:cisco:catalyst_9300",
    ])
  })

  it("puts a typed name first", () => {
    const rows = cpeOptions(result({ typed: XE, local: [], remote: [] }), ["o"])
    expect(rows).toHaveLength(1)
    expect(rows[0].from).toBe("typed")
  })

  it("is empty before an answer", () => {
    expect(cpeOptions(undefined, ["o"])).toEqual([])
  })
})

describe("remoteNote", () => {
  it("says why NVD was not asked", () => {
    expect(remoteNote(result({ remote_status: "off" }))).toMatch(/server mode/)
    expect(
      remoteNote(result({ remote_status: "limited", retry_after: 12 }))
    ).toMatch(/12 s/)
    expect(
      remoteNote(result({ remote_status: "error", remote_error: "boom" }))
    ).toBe("boom")
    expect(remoteNote(result())).toBeNull()
    expect(remoteNote(result({ typed: XE, remote_status: "off" }))).toBeNull()
  })
})

describe("CpePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiMock.mockReset()
    apiMock.mockResolvedValue(result())
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("searches after a pause and hands back the picked name", async () => {
    const onChange = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CpePicker value={null} onChange={onChange} parts={["o", "a"]} />
      </QueryClientProvider>
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ios xe" },
    })
    expect(apiMock).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(CPE_SEARCH_DEBOUNCE_MS + 10)
    })
    expect(apiMock).toHaveBeenCalledWith(
      "/api/vulnerabilities/cpe/search/?q=ios%20xe"
    )
    const option = await screen.findByText("cpe:2.3:o:cisco:ios_xe")
    expect(screen.getByText("560 stored")).toBeTruthy()
    expect(screen.queryByText("cpe:2.3:h:cisco:catalyst_9300")).toBeNull()
    fireEvent.click(option)
    expect(onChange).toHaveBeenCalledWith("cpe:2.3:o:cisco:ios_xe")
  })

  it("does not search one character", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CpePicker value={null} onChange={() => {}} parts={["o"]} />
      </QueryClientProvider>
    )
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } })
    await act(async () => {
      vi.advanceTimersByTime(CPE_SEARCH_DEBOUNCE_MS + 10)
    })
    expect(apiMock).not.toHaveBeenCalled()
  })
})

describe("mapping card helpers", () => {
  const row = {
    mapping: {} as never,
    objects: 44,
    matched: 41,
    blank_version: 0,
    version_not_understood: 3,
    records: {},
  }

  it("reads coverage as one line", () => {
    expect(coverageLine(row, "platform")).toBe(
      "41 of 44 hosts matched · 3 with a version Danbyte cannot read"
    )
    expect(coverageLine({ ...row, blank_version: 2 }, "application")).toBe(
      "41 of 44 installs matched · 2 without a version · 3 with a version Danbyte cannot read"
    )
    expect(coverageLine({ ...row, objects: 1 }, "device_type")).toBe(
      "Hardware context for 1 device"
    )
  })

  it("defaults to the SBOM identifier, package URL first", () => {
    expect(
      sbomIdentifier({
        id: "1",
        name: "Django",
        purl_template: "pkg:pypi/django@{version}",
        cpe_template: "cpe:2.3:a:djangoproject:django:{version}",
      })
    ).toBe("pkg:pypi/django@{version}")
    expect(sbomIdentifier({ id: "1", name: "X" })).toBe("")
  })
})
