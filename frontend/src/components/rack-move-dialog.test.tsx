// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { RackMoveResult } from "@/lib/api"
import { MoveImpact } from "./rack-move-dialog"

// The impact preview of "Move to site…" (#394): what goes along, what is
// cleared and what blocks, as the server's dry run reports it.

afterEach(cleanup)

const base: RackMoveResult = {
  rack: { id: "r1", name: "R1" },
  from_site: { id: "a", name: "SiteA" },
  to_site: { id: "b", name: "SiteB" },
  to_location: null,
  devices: [
    {
      id: "d1",
      name: "srv1",
      position: 10,
      face: "rear",
      mount: "",
      racked: true,
    },
    {
      id: "d2",
      name: "pdu1",
      position: null,
      face: "",
      mount: "side_left",
      racked: true,
    },
  ],
  cleared: { floor_plan_tiles: 0 },
  blockers: [],
  can_move: true,
  moved: false,
}

describe("MoveImpact", () => {
  it("lists the devices going along", () => {
    render(<MoveImpact result={base} />)
    expect(screen.getByText("srv1, pdu1")).toBeTruthy()
    expect(screen.queryByText(/Blocking the move/)).toBeNull()
    expect(screen.queryByText(/Cleared/)).toBeNull()
  })

  it("lists every blocker and the cleared tiles", () => {
    render(
      <MoveImpact
        result={{
          ...base,
          can_move: false,
          cleared: { floor_plan_tiles: 2 },
          blockers: [
            {
              code: "cable",
              message: "Cable #3 on srv1 eth0 leaves the rack.",
            },
            { code: "name", message: "SiteB already has a rack named R1." },
          ],
        }}
      />
    )
    expect(screen.getByText(/Blocking the move/)).toBeTruthy()
    expect(
      screen.getByText("Cable #3 on srv1 eth0 leaves the rack.")
    ).toBeTruthy()
    expect(screen.getByText("SiteB already has a rack named R1.")).toBeTruthy()
    expect(screen.getByText("2 floor-plan tiles at SiteA")).toBeTruthy()
  })
})
