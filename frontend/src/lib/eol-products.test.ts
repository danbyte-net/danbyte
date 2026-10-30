import { describe, expect, it } from "vitest"

import {
  eolProductOptions,
  productKey,
  splitProductKey,
} from "@/lib/eol-products"

const row = (source: string, name: string, label: string) => ({
  source,
  name,
  label,
  category: "",
  custom: source === "custom",
})

describe("end-of-life product picker", () => {
  it("lists the fetched and the custom products, the custom ones chipped", () => {
    const options = eolProductOptions(
      [
        row("endoflife_date", "postgresql", "PostgreSQL"),
        row("custom", "acme-erp", "Acme ERP"),
        row("endoflife_date", "nginx", "nginx"),
      ],
      []
    )
    expect(options.map((o) => [o.value, o.group, o.chip])).toEqual([
      ["custom:acme-erp", "Custom products", "Custom"],
      ["endoflife_date:postgresql", "All products", undefined],
      ["endoflife_date:nginx", "All products", undefined],
    ])
  })

  it("keeps a custom product apart from a fetched one of the same name", () => {
    const options = eolProductOptions(
      [
        row("endoflife_date", "java", "Java"),
        row("custom", "java", "Our Java"),
      ],
      [
        {
          source: "custom",
          name: "java",
          label: "Our Java",
          score: 10,
          cycle: "",
        },
      ]
    )
    expect(options.map((o) => [o.value, o.group, o.chip])).toEqual([
      ["custom:java", "Suggested", "Custom"],
      ["endoflife_date:java", "All products", undefined],
    ])
  })

  it("round-trips a picker value to the source and product", () => {
    expect(splitProductKey(productKey("custom", "a:b"))).toEqual({
      source: "custom",
      product: "a:b",
    })
  })
})
