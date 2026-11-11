// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { DiscoveryFinding } from "@/lib/api"
import {
  ConfidenceBadge,
  FINDING_KIND_LABELS,
  buildFindingColumns,
  buildObservedServiceColumns,
} from "@/components/columns/service-scan-columns"

afterEach(cleanup)

describe("service scan columns", () => {
  it("shows confidence as a badge, one variant per level", () => {
    render(
      <>
        <ConfidenceBadge value="high" />
        <ConfidenceBadge value="low" />
      </>
    )
    expect(screen.getByText("High").className).not.toEqual(
      screen.getByText("Low").className
    )
  })

  it("has one factory per table with stable ids", () => {
    const ids = buildObservedServiceColumns().map((c) => c.id)
    expect(ids).toEqual([
      "address",
      "host",
      "port",
      "service",
      "product",
      "confidence",
      "source",
      "banner",
      "last_seen",
    ])
    const actions = (f: DiscoveryFinding) => f.id
    const fids = buildFindingColumns({ actions }).map((c) => c.id)
    expect(fids).toEqual([
      "select",
      "host",
      "port",
      "kind",
      "confidence",
      "source",
      "evidence",
      "last_seen",
      "actions",
    ])
    expect(buildFindingColumns().map((c) => c.id)).not.toContain("actions")
  })

  it("labels every proposal kind tersely", () => {
    expect(Object.values(FINDING_KIND_LABELS)).toEqual([
      "Add service",
      "Add software",
      "Map to CPE",
      "Set platform",
      "Add application",
      "Link packages",
    ])
  })
})
