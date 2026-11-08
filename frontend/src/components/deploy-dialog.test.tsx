// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

import type { DeployPipeline } from "@/lib/api"
import { defaultPipeline } from "@/components/deploy-dialog"
import { PipelineStepBadges } from "@/components/deploy-pipeline-status"

const pipe = (id: string, roles: string[]) =>
  ({ id, name: id, roles }) as unknown as DeployPipeline

describe("defaultPipeline", () => {
  it("picks the pipeline whose roles include the object's role", () => {
    const list = [pipe("a", ["r1"]), pipe("b", ["r2", "r3"])]
    expect(defaultPipeline(list, ["r3"])?.id).toBe("b")
    expect(defaultPipeline(list, ["r9"])).toBeUndefined()
    expect(defaultPipeline(list, [null, undefined])).toBeUndefined()
  })
})

describe("PipelineStepBadges", () => {
  it("renders one numbered badge per step and names their statuses", () => {
    render(
      <PipelineStepBadges
        steps={[
          { step: 1, status: "succeeded", target_name: "a" },
          { step: 2, status: "failed", target_name: "b" },
          { step: 3, status: "skipped", target_name: "c" },
        ]}
      />
    )
    const group = screen.getByRole("img")
    expect(group.getAttribute("aria-label")).toBe(
      "step 1 succeeded, step 2 failed, step 3 skipped"
    )
    expect(group.textContent).toBe("123")
    expect(
      group.querySelector('[data-variant="destructive"]')?.textContent
    ).toBe("2")
  })
})
