import { describe, expect, it } from "vitest"

import {
  parsePipelineYaml,
  pipelineToYaml,
  PipelineCodeError,
  yamlScalar,
} from "@/lib/pipeline-code"

const ROUTER = {
  name: "Router",
  object_types: ["device"],
  auto_on_change: false,
  steps: [
    { target: "Proxmox VNets", stop_on_failure: true },
    { target: "Proxmox VNets (os-deploy)", wait_for_result: true },
    { target: "DKW01 deploy runner (os-deploy)", wait_for_result: true },
  ],
}

describe("pipeline as code", () => {
  it("writes the editor's YAML", () => {
    expect(pipelineToYaml(ROUTER)).toBe(
      [
        "name: Router",
        "object_types: [device]",
        "auto_on_change: false",
        "steps:",
        "  - target: Proxmox VNets",
        "  - target: Proxmox VNets (os-deploy)",
        "    wait_for_result: true",
        "  - target: DKW01 deploy runner (os-deploy)",
        "    wait_for_result: true",
        "",
      ].join("\n")
    )
  })

  it("reads back what it writes", () => {
    const full = pipelineToYaml(
      { ...ROUTER, description: 'say "hi": #1', roles: ["Core, edge"] },
      { full: true }
    )
    const back = parsePipelineYaml(full)
    expect(back.name).toBe("Router")
    expect(back.description).toBe('say "hi": #1')
    expect(back.roles).toEqual(["Core, edge"])
    expect(back.steps).toHaveLength(3)
    expect(back.steps[1]).toEqual({
      target: "Proxmox VNets (os-deploy)",
      stop_on_failure: true,
      wait_for_result: true,
      timeout_minutes: 30,
    })
  })

  it("quotes what would read back as something else", () => {
    expect(yamlScalar("true")).toBe('"true"')
    expect(yamlScalar("42")).toBe('"42"')
    expect(yamlScalar("a: b")).toBe('"a: b"')
    expect(yamlScalar("")).toBe('""')
    expect(yamlScalar("Push config")).toBe("Push config")
  })

  it("skips comments and accepts JSON", () => {
    const y = "# mine\nname: X # trailing\nsteps:\n  - target: 'it''s'\n"
    expect(parsePipelineYaml(y).steps[0].target).toBe("it's")
    expect(parsePipelineYaml('{"name":"J","steps":[]}').name).toBe("J")
  })

  it("names the bad line", () => {
    expect(() => parsePipelineYaml("name: X\nbogus: 1\n")).toThrow(
      PipelineCodeError
    )
    expect(() =>
      parsePipelineYaml("name: X\nsteps:\n  - colour: red\n")
    ).toThrow(/Line 3/)
    expect(() => parsePipelineYaml("steps:\n  - target: a\n")).toThrow(/name/)
  })
})
