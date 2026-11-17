// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { FaceplateLegend } from "./device-faceplate"

afterEach(cleanup)

describe("FaceplateLegend", () => {
  it("keys the trunk mark for the 2D faceplate", () => {
    render(<FaceplateLegend />)
    expect(screen.getByText("trunk")).toBeTruthy()
  })

  it("leaves the trunk mark out where none is drawn (the 3D view)", () => {
    render(<FaceplateLegend trunk={false} />)
    expect(screen.queryByText("trunk")).toBeNull()
    expect(screen.getByText("100G")).toBeTruthy()
  })
})
