import { describe, expect, it } from "vitest"

import {
  KINDS,
  buildParams,
  initialValues,
  missingRequired,
  specsFor,
} from "@/components/monitoring/check-fields"

describe("a registered kind with no field spec", () => {
  it("has no fields rather than crashing", () => {
    expect(specsFor("zabbix")).toEqual([])
    expect(initialValues("zabbix")).toEqual({})
  })

  it("is never blocked by a missing required field", () => {
    expect(missingRequired("zabbix", {})).toBe(false)
  })

  it("builds an empty params payload", () => {
    expect(buildParams("zabbix", {})).toEqual({ params: {}, secret_params: {} })
  })

  it("still resolves the shipped kinds", () => {
    expect(specsFor("icmp").length).toBeGreaterThan(0)
    expect(KINDS.some((k) => k.value === "icmp")).toBe(true)
  })
})
