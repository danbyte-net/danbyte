import { describe, expect, it } from "vitest"
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec"

import {
  browserLanguages,
  buildVectorStyle,
  classifySource,
  labelExpression,
  labelLanguages,
  PALETTES,
  relabelStyle,
  type VectorStyle,
} from "./vector-style"

const SOURCE = {
  type: "vector" as const,
  tiles: ["https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt"],
  maxzoom: 14,
}

/** Evaluate a label expression against one feature's properties - the
 * handful of operators labelExpression uses. */
function evaluate(e: unknown, props: Record<string, string>): unknown {
  if (!Array.isArray(e)) return e
  const [op, ...args] = e as [string, ...unknown[]]
  const ev = (x: unknown) => evaluate(x, props)
  switch (op) {
    case "get":
      return props[args[0] as string] ?? null
    case "has":
      return (args[0] as string) in props
    case "coalesce":
      for (const a of args) {
        const v = ev(a)
        if (v !== null && v !== undefined) return v
      }
      return null
    case "all":
      return args.every((a) => ev(a))
    case "!=":
      return ev(args[0]) !== ev(args[1])
    case "case":
      for (let i = 0; i + 1 < args.length; i += 2)
        if (ev(args[i])) return ev(args[i + 1])
      return ev(args[args.length - 1])
    case "concat":
      return args.map(ev).join("")
    default:
      throw new Error(`unexpected operator ${op}`)
  }
}

const DUBAI_ROAD = { name: "شارع الشيخ زايد", name_en: "Sheikh Zayed Road" }
const LOCAL_ONLY = { name: "سوق" }

describe("label language", () => {
  it("reads the browser's languages as primary subtags, best first", () => {
    expect(
      browserLanguages(["da-DK", "en-GB", "en", "zh-Hant-TW", "x-bad", "*"])
    ).toEqual(["da", "en", "zh"])
    expect(browserLanguages([])).toEqual([])
  })

  it("picks name_<lang> and falls back to the local name", () => {
    expect(evaluate(labelExpression("en"), DUBAI_ROAD)).toBe(
      "Sheikh Zayed Road"
    )
    expect(evaluate(labelExpression("en"), LOCAL_ONLY)).toBe("سوق")
    expect(evaluate(labelExpression("local"), DUBAI_ROAD)).toBe(
      "شارع الشيخ زايد"
    )
    expect(evaluate(labelExpression("en"), {})).toBe("")
  })

  it("tries each browser language before the local name", () => {
    const de = {
      name: "København",
      name_de: "Kopenhagen",
      name_en: "Copenhagen",
    }
    expect(evaluate(labelExpression("browser", ["da", "de"]), de)).toBe(
      "Kopenhagen"
    )
    expect(evaluate(labelExpression("browser", ["fr"]), de)).toBe("København")
    expect(labelLanguages("browser", [])).toEqual([])
    expect(evaluate(labelExpression("browser", []), de)).toBe("København")
  })

  it("adds the local name in brackets only when it differs", () => {
    expect(evaluate(labelExpression("en_local"), DUBAI_ROAD)).toBe(
      "Sheikh Zayed Road (شارع الشيخ زايد)"
    )
    expect(evaluate(labelExpression("en_local"), LOCAL_ONLY)).toBe("سوق")
    expect(
      evaluate(labelExpression("en_local"), { name: "Oslo", name_en: "Oslo" })
    ).toBe("Oslo")
    expect(evaluate(labelExpression("browser_local", ["de"]), DUBAI_ROAD)).toBe(
      "شارع الشيخ زايد"
    )
  })
})

describe("bundled style", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const labelsOnly of [false, true]) {
      it(`is a valid MapLibre style (${theme}${labelsOnly ? ", labels only" : ""})`, () => {
        const style = buildVectorStyle({
          theme,
          source: SOURCE,
          labels: "en",
          labelsOnly,
        })
        expect(validateStyleMin(style as never)).toEqual([])
        // Everything but the tiles ships with Danbyte.
        expect(style.glyphs).toBeUndefined()
        expect(style.sprite).toBeUndefined()
        expect(JSON.stringify(style)).not.toMatch(
          /https?:\/\/(?!vector\.openstreetmap\.org)/
        )
      })
    }
  }

  it("draws light and dark from their own palettes", () => {
    const light = buildVectorStyle({
      theme: "light",
      source: SOURCE,
      labels: "en",
    })
    const dark = buildVectorStyle({
      theme: "dark",
      source: SOURCE,
      labels: "en",
    })
    const bg = (s: VectorStyle) => s.layers[0].paint?.["background-color"]
    expect(bg(light)).toBe(PALETTES.light.bg)
    expect(bg(dark)).toBe(PALETTES.dark.bg)
  })

  it("over satellite has only labels", () => {
    const s = buildVectorStyle({
      theme: "dark",
      source: SOURCE,
      labels: "local",
      labelsOnly: true,
    })
    expect(s.layers.every((l) => l.type === "symbol")).toBe(true)
    expect(s.layers.length).toBeGreaterThan(0)
  })

  it("puts the chosen language in every label layer", () => {
    const s = buildVectorStyle({
      theme: "light",
      source: SOURCE,
      labels: "en_local",
    })
    const want = JSON.stringify(labelExpression("en_local"))
    for (const l of s.layers.filter((x) => x.type === "symbol"))
      expect(JSON.stringify(l.layout?.["text-field"])).toBe(want)
  })
})

describe("vector source", () => {
  it("reads a TileJSON's tiles and drops its attribution HTML", () => {
    const got = classifySource({
      tilejson: "3.0.0",
      tiles: [
        "https://t.example/{z}/{x}/{y}.mvt",
        "http://insecure.example/{z}/{x}/{y}",
      ],
      attribution: '<img src=x onerror="alert(1)">',
      minzoom: 0,
      maxzoom: 14,
    })
    expect(got).toEqual({
      kind: "tilejson",
      source: {
        type: "vector",
        tiles: ["https://t.example/{z}/{x}/{y}.mvt"],
        minzoom: 0,
        maxzoom: 14,
      },
    })
  })

  it("tells a style from a TileJSON and refuses anything else", () => {
    expect(classifySource({ version: 8, sources: {}, layers: [] }).kind).toBe(
      "style"
    )
    expect(classifySource({ tiles: [] }).kind).toBe("invalid")
    expect(classifySource("nope").kind).toBe("invalid")
    expect(classifySource(null).kind).toBe("invalid")
  })

  it("relabels a third-party style's name labels only", () => {
    const style: VectorStyle = {
      version: 8,
      sources: {},
      layers: [
        { id: "a", type: "symbol", layout: { "text-field": ["get", "name"] } },
        { id: "b", type: "symbol", layout: { "text-field": "{name_de}" } },
        {
          id: "c",
          type: "symbol",
          layout: { "text-field": ["get", "housenumber"] },
        },
        { id: "d", type: "line" },
      ],
    }
    const out = relabelStyle(style, "en")
    const want = labelExpression("en")
    expect(out.layers[0].layout?.["text-field"]).toEqual(want)
    expect(out.layers[1].layout?.["text-field"]).toEqual(want)
    expect(out.layers[2].layout?.["text-field"]).toEqual(["get", "housenumber"])
    expect(style.layers[0].layout?.["text-field"]).toEqual(["get", "name"])
  })
})
