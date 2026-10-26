// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { PrtgChannel } from "@/lib/api"
import {
  ChannelReading,
  ChannelTrend,
  LookupTimeline,
  lookupStatesAt,
  pickChannel,
  trendOf,
} from "./channel-view"
import type { HistorySeries } from "./channel-view"

// The rules every channel surface shares: which channels get a line, when a
// line is "steady" instead, how a lookup's history becomes a state timeline,
// and "No value" for a channel PRTG has nothing for.

afterEach(cleanup)

function channel(patch: Partial<PrtgChannel> = {}): PrtgChannel {
  return {
    id: "2",
    name: "Days to Expiration",
    value: "781 #",
    value_raw: 781,
    unit: "#",
    kind: "number",
    state: "up",
    status: "Up",
    lookup_label: "",
    limits: { warn_min: 30, warn_max: null, error_min: 7, error_max: null },
    lookup_states: [],
    min: 0,
    max: 800,
    primary: false,
    ...patch,
  }
}

const TRUSTED = channel({
  id: "3",
  name: "Root Authority Trusted",
  value: "No",
  value_raw: 1,
  unit: "",
  kind: "lookup",
  state: "degraded",
  lookup_label: "No",
  limits: { warn_min: null, warn_max: null, error_min: null, error_max: null },
  lookup_states: [
    { value: 0, to: null, label: "Yes", state: "ok" },
    { value: 1, to: null, label: "No", state: "warning" },
  ],
  min: null,
  max: null,
})

function series(
  values: (number | null)[],
  patch: Partial<HistorySeries> = {}
): HistorySeries {
  return {
    id: "2",
    name: "Days to Expiration",
    unit: "#",
    points: values.map((v, i) => ({
      t: `2026-10-26T07:${String(i * 5).padStart(2, "0")}:00Z`,
      v,
    })),
    ...patch,
  }
}

describe("trendOf", () => {
  it("draws a number that moved", () => {
    expect(trendOf(channel(), series([780, null, 781])).kind).toBe("line")
  })

  it("calls a flat number steady, not a line", () => {
    // The SSL sensor's Days to Expiration: one value between gaps.
    expect(trendOf(channel(), series([null, 781, null, 781]))).toEqual({
      kind: "steady",
      value: 781,
    })
  })

  it("draws nothing with fewer than two values", () => {
    expect(trendOf(channel(), series([null, 781, null])).kind).toBe("none")
    expect(trendOf(channel(), undefined).kind).toBe("none")
  })

  it("never draws a line for a lookup or text", () => {
    expect(trendOf(TRUSTED, series([0, 100])).kind).toBe("timeline")
    expect(trendOf(channel({ kind: "text" }), series([1, 2])).kind).toBe("none")
  })
})

describe("lookup history", () => {
  it("reads PRTG's share of time in the named state", () => {
    const s = series([0, 100, null, 30], {
      id: "3",
      name: "Root Authority Trusted (Yes)",
      unit: "%",
    })
    expect(lookupStatesAt(TRUSTED, s).map((e) => e?.label ?? null)).toEqual([
      "No",
      "Yes",
      null,
      "No",
    ])
  })

  it("reads a raw lookup value directly", () => {
    const s = series([1, 0], {
      id: "3",
      name: "Root Authority Trusted",
      unit: "",
    })
    expect(lookupStatesAt(TRUSTED, s).map((e) => e?.label)).toEqual([
      "No",
      "Yes",
    ])
  })

  it("draws runs of a state as coloured segments, no axis", () => {
    const s = series([0, 0, 100], {
      id: "3",
      name: "Root Authority Trusted (Yes)",
      unit: "%",
    })
    render(<LookupTimeline channel={TRUSTED} series={s} range="24h" />)
    const tl = screen.getByTestId("prtg-lookup-timeline")
    const segs = [...tl.querySelectorAll("[data-state]")]
    expect(segs.map((x) => x.getAttribute("data-state"))).toEqual(["No", "Yes"])
    expect(segs[0].getAttribute("data-tone")).toBe("warning")
    expect((segs[0] as HTMLElement).style.flexGrow).toBe("2")
    expect(tl.textContent).not.toContain("%")
    expect(tl.textContent).toContain("24h ago")
  })
})

describe("ChannelReading", () => {
  it("says No value when PRTG has none", () => {
    // The Downtime channel: a number with no reading.
    render(
      <ChannelReading
        channel={channel({ name: "Downtime", value: "", value_raw: null })}
      />
    )
    expect(screen.getByTestId("prtg-no-value").textContent).toBe("No value")
    expect(document.querySelector("[role=meter]")).toBeNull()
  })

  it("draws a gauge, a lookup bar or the value", () => {
    const { rerender } = render(<ChannelReading channel={channel()} />)
    expect(document.querySelector("[role=meter]")).toBeTruthy()
    rerender(<ChannelReading channel={channel()} display="value" />)
    expect(screen.getByTestId("prtg-channel-value").textContent).toBe("781 #")
    rerender(<ChannelReading channel={TRUSTED} />)
    expect(document.querySelector("[data-current]")).toBeTruthy()
  })
})

describe("ChannelTrend", () => {
  it("says steady over the range instead of a flat sparkline", () => {
    render(
      <ChannelTrend
        channel={channel()}
        series={series([781, 781])}
        range="1h"
      />
    )
    expect(screen.getByTestId("prtg-steady").textContent).toBe(
      "Steady over the last 1h"
    )
  })
})

it("picks the primary channel for an empty id", () => {
  const rows = [channel(), channel({ id: "0", primary: true })]
  expect(pickChannel(rows, "")?.id).toBe("0")
  expect(pickChannel(rows, "2")?.id).toBe("2")
  expect(pickChannel(rows, "9")).toBeUndefined()
})
