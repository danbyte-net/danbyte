import { describe, expect, it } from "vitest"

import { bulkFields } from "./component-bulk-bar"
import { UPLINK_OPTIONS, uplinkFields } from "@/lib/mac-tracking"
import type { BulkFieldSpec } from "@/components/forms"
import type { UplinkMode } from "@/lib/mac-tracking"

const FIELDS: BulkFieldSpec[] = [
  { key: "enabled", label: "Enabled", kind: "bool" },
  { key: "mtu", label: "MTU", kind: "int" },
  {
    key: "uplink",
    label: "Uplink",
    kind: "options",
    options: UPLINK_OPTIONS,
    expand: (v) => uplinkFields(v as UplinkMode),
  },
]

describe("bulkFields", () => {
  it("sends Uplink as the two fields it stands for", () => {
    expect(bulkFields({ uplink: "never", enabled: true }, FIELDS)).toEqual({
      enabled: true,
      is_uplink: false,
      never_uplink: true,
    })
    expect(bulkFields({ uplink: "always" }, FIELDS)).toEqual({
      is_uplink: true,
      never_uplink: false,
    })
    expect(bulkFields({ uplink: "auto" }, FIELDS)).toEqual({
      is_uplink: false,
      never_uplink: false,
    })
  })

  it("passes every other field through, a cleared one included", () => {
    expect(bulkFields({ mtu: null, enabled: false }, FIELDS)).toEqual({
      mtu: null,
      enabled: false,
    })
  })
})
