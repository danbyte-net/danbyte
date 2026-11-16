// The vector basemap's style (#467): a restrained Shortbread 1.1 style in
// the Site map's muted look, light and dark, plus a labels-only variant that
// sits over satellite imagery. Pure data - no maplibre import - so the main
// bundle and the tests can use it; vector-basemap.ts (lazy) hands it to
// MapLibre.
//
// No `glyphs` and no `sprite`: MapLibre draws the label glyphs locally from
// the app's own font (Inter, already bundled, OFL) and the style uses no
// icons, so the only host the browser contacts is the tile host.

import type { MapLabelLanguage } from "@/lib/api"

/** A label language setting (DeploymentSettings.MAP_LABEL_CHOICES). */
export type LabelLanguage = MapLabelLanguage

/** The label languages (core DeploymentSettings.MAP_LABEL_CHOICES), also
 * offered per user under Preferences. */
export const LABEL_LANGUAGE_OPTIONS: {
  value: MapLabelLanguage
  label: string
}[] = [
  { value: "en", label: "English" },
  { value: "en_local", label: "English and local" },
  { value: "browser", label: "Browser language" },
  { value: "browser_local", label: "Browser language and local" },
  { value: "local", label: "Local" },
]

export type MapTheme = "light" | "dark"

// A loose style shape: the real StyleSpecification lives in maplibre-gl,
// which must stay out of the main bundle.
type Expr = unknown[]
export interface VectorSourceSpec {
  type: "vector"
  tiles?: string[]
  url?: string
  minzoom?: number
  maxzoom?: number
  bounds?: number[]
}
export interface StyleLayer {
  id: string
  type: string
  source?: string
  "source-layer"?: string
  minzoom?: number
  maxzoom?: number
  filter?: unknown
  layout?: Record<string, unknown>
  paint?: Record<string, unknown>
}
export interface VectorStyle {
  version: 8
  name?: string
  sources: Record<string, VectorSourceSpec | Record<string, unknown>>
  layers: StyleLayer[]
  glyphs?: string
  sprite?: unknown
  [key: string]: unknown
}

/** The CSS font the labels are drawn with (styles.css --font-sans). */
export const LABEL_FONT = ["Inter Variable"]
export const LABEL_FONT_BOLD = ["Inter Variable Semibold", "Inter Variable"]

const LANG_RE = /^[a-z]{2,3}$/

/** The language codes `browser` means, best first: the primary subtag of
 * each of the browser's languages, deduplicated. */
export function browserLanguages(
  langs: readonly string[] | undefined = typeof navigator !== "undefined"
    ? navigator.languages
    : undefined
): string[] {
  const out: string[] = []
  for (const l of langs ?? []) {
    const code = String(l).toLowerCase().split(/[-_]/)[0]
    if (LANG_RE.test(code) && !out.includes(code)) out.push(code)
  }
  return out
}

/** The `name_<lang>` keys a setting tries, best first, before the local
 * `name`. */
export function labelLanguages(
  setting: LabelLanguage,
  browser: readonly string[] = browserLanguages()
): string[] {
  if (setting === "local") return []
  if (setting === "en" || setting === "en_local") return ["en"]
  return browser.filter((c) => LANG_RE.test(c))
}

/**
 * The `text-field` expression for a setting: the first `name_<lang>` a
 * feature has, else its local `name`. The `_local` settings add the local
 * name in brackets when it differs, e.g. "Sheikh Zayed Rd (شارع الشيخ زايد)".
 */
export function labelExpression(
  setting: LabelLanguage,
  browser: readonly string[] = browserLanguages()
): Expr {
  const local: Expr = ["get", "name"]
  const langs = labelLanguages(setting, browser)
  if (langs.length === 0) return ["coalesce", local, ""]
  const primary: Expr = [
    "coalesce",
    ...langs.map((l) => ["get", `name_${l}`]),
    local,
    "",
  ]
  if (!setting.endsWith("_local")) return primary
  return [
    "case",
    ["all", ["has", "name"], ["!=", primary, local]],
    ["concat", primary, " (", local, ")"],
    primary,
  ]
}

interface Palette {
  bg: string
  water: string
  waterLabel: string
  green: string
  grey: string
  building: string
  buildingLine: string
  road: string
  roadMajor: string
  motorway: string
  casing: string
  rail: string
  boundary: string
  label: string
  labelMinor: string
  halo: string
}

// Zinc greys with a hint of blue for water and green for parks: colour only
// where it tells you something, like the rest of the product.
export const PALETTES: Record<MapTheme, Palette> = {
  light: {
    bg: "#f4f4f5",
    water: "#cfd8e3",
    waterLabel: "#64748b",
    green: "#e3e9de",
    grey: "#ececee",
    building: "#e4e4e7",
    buildingLine: "#d4d4d8",
    road: "#ffffff",
    roadMajor: "#ffffff",
    motorway: "#fafafa",
    casing: "#d4d4d8",
    rail: "#c4c4cc",
    boundary: "#a1a1aa",
    label: "#3f3f46",
    labelMinor: "#52525b",
    halo: "#f4f4f5",
  },
  dark: {
    bg: "#18181b",
    water: "#1f2733",
    waterLabel: "#7d8ba0",
    green: "#1b231d",
    grey: "#1f1f23",
    building: "#27272a",
    buildingLine: "#303036",
    road: "#2a2a2f",
    roadMajor: "#34343a",
    motorway: "#3f3f46",
    casing: "#111113",
    rail: "#3f3f46",
    boundary: "#52525b",
    label: "#d4d4d8",
    labelMinor: "#a1a1aa",
    halo: "#18181b",
  },
}

const SRC = "shortbread"

const GREEN_KINDS = [
  "park",
  "forest",
  "wood",
  "grass",
  "grassland",
  "meadow",
  "garden",
  "cemetery",
  "grave_yard",
  "golf_course",
  "playground",
  "village_green",
  "allotments",
  "heath",
  "scrub",
  "recreation_ground",
  "dog_park",
  "orchard",
  "vineyard",
]
const GREY_KINDS = [
  "industrial",
  "commercial",
  "retail",
  "railway",
  "military",
  "quarry",
  "landfill",
  "brownfield",
]
const MAJOR = ["motorway", "trunk", "primary", "secondary"]
const MINOR = [
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "pedestrian",
  "service",
]

/** Width factor per street kind, for one zoom curve. */
const STREET_WIDTH: Expr = [
  "interpolate",
  ["exponential", 1.6],
  ["zoom"],
  5,
  [
    "match",
    ["get", "kind"],
    "motorway",
    0.8,
    "trunk",
    0.7,
    "primary",
    0.5,
    0.2,
  ],
  12,
  [
    "match",
    ["get", "kind"],
    "motorway",
    3,
    "trunk",
    2.6,
    "primary",
    2.2,
    "secondary",
    1.8,
    "tertiary",
    1.4,
    "service",
    0.5,
    1,
  ],
  18,
  [
    "match",
    ["get", "kind"],
    "motorway",
    22,
    "trunk",
    20,
    "primary",
    18,
    "secondary",
    16,
    "tertiary",
    14,
    "service",
    6,
    10,
  ],
]

/** The street width curve, widened by `extra` pixels at every stop (the
 * casing) - a zoom curve must stay the top-level expression. */
function streetWidth(extra = 0): Expr {
  if (!extra) return STREET_WIDTH
  return STREET_WIDTH.map((v, i) =>
    i >= 4 && i % 2 === 0 ? ["+", v, extra] : v
  )
}

function labelLayers(
  p: Pick<Palette, "label" | "labelMinor" | "halo" | "waterLabel">,
  text: Expr
): StyleLayer[] {
  const textPaint = (color: string) => ({
    "text-color": color,
    "text-halo-color": p.halo,
    "text-halo-width": 1.4,
    "text-halo-blur": 0.4,
  })
  return [
    {
      id: "water-labels",
      type: "symbol",
      source: SRC,
      "source-layer": "water_polygons_labels",
      minzoom: 8,
      layout: {
        "text-field": text,
        "text-font": LABEL_FONT,
        "text-size": 11,
        "text-max-width": 8,
      },
      paint: textPaint(p.waterLabel),
    },
    {
      id: "street-labels",
      type: "symbol",
      source: SRC,
      "source-layer": "street_labels",
      minzoom: 12,
      filter: [
        "any",
        ["in", ["get", "kind"], ["literal", MAJOR]],
        [">=", ["zoom"], 14],
      ],
      layout: {
        "symbol-placement": "line",
        "text-field": text,
        "text-font": LABEL_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 17, 12],
        "text-max-angle": 30,
        "symbol-spacing": 320,
      },
      paint: textPaint(p.labelMinor),
    },
    {
      id: "boundary-labels",
      type: "symbol",
      source: SRC,
      "source-layer": "boundary_labels",
      maxzoom: 7,
      filter: ["==", ["get", "admin_level"], 2],
      layout: {
        "text-field": text,
        "text-font": LABEL_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 6, 13],
        "text-letter-spacing": 0.08,
        "text-max-width": 7,
        "symbol-sort-key": ["-", 0, ["coalesce", ["get", "way_area"], 0]],
      },
      paint: textPaint(p.labelMinor),
    },
    {
      id: "place-labels",
      type: "symbol",
      source: SRC,
      "source-layer": "place_labels",
      layout: {
        "text-field": text,
        "text-font": [
          "match",
          ["get", "kind"],
          ["capital", "state_capital", "city"],
          ["literal", LABEL_FONT_BOLD],
          ["literal", LABEL_FONT],
        ],
        "text-size": [
          "match",
          ["get", "kind"],
          "capital",
          14,
          "state_capital",
          13,
          "city",
          13,
          "town",
          12,
          ["suburb", "quarter", "neighbourhood"],
          11,
          11,
        ],
        "text-max-width": 8,
        "symbol-sort-key": ["-", 0, ["coalesce", ["get", "population"], 0]],
      },
      paint: textPaint(p.label),
    },
  ]
}

/**
 * The basemap style. `source` is the vector source (a TileJSON's tiles, or
 * its URL); `labels` the setting; `labelsOnly` the overlay for satellite
 * imagery: no fills or lines, light text on a dark halo.
 */
export function buildVectorStyle({
  theme,
  source,
  labels,
  browser,
  labelsOnly = false,
}: {
  theme: MapTheme
  source: VectorSourceSpec
  labels: LabelLanguage
  browser?: readonly string[]
  labelsOnly?: boolean
}): VectorStyle {
  const p = PALETTES[theme]
  const text = labelExpression(labels, browser)
  const sources = { [SRC]: { ...source } }
  if (labelsOnly) {
    return {
      version: 8,
      name: "Danbyte labels",
      sources,
      layers: labelLayers(
        {
          label: "#fafafa",
          labelMinor: "#e4e4e7",
          waterLabel: "#dbeafe",
          halo: "rgba(9, 9, 11, 0.8)",
        },
        text
      ),
    }
  }
  const layers: StyleLayer[] = [
    {
      id: "background",
      type: "background",
      paint: { "background-color": p.bg },
    },
    {
      id: "ocean",
      type: "fill",
      source: SRC,
      "source-layer": "ocean",
      paint: { "fill-color": p.water },
    },
    {
      id: "land-green",
      type: "fill",
      source: SRC,
      "source-layer": "land",
      filter: ["in", ["get", "kind"], ["literal", GREEN_KINDS]],
      paint: { "fill-color": p.green },
    },
    {
      id: "land-grey",
      type: "fill",
      source: SRC,
      "source-layer": "land",
      filter: ["in", ["get", "kind"], ["literal", GREY_KINDS]],
      paint: { "fill-color": p.grey },
    },
    {
      id: "water",
      type: "fill",
      source: SRC,
      "source-layer": "water_polygons",
      paint: { "fill-color": p.water },
    },
    {
      id: "water-lines",
      type: "line",
      source: SRC,
      "source-layer": "water_lines",
      filter: ["!=", ["get", "tunnel"], true],
      paint: {
        "line-color": p.water,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          9,
          ["match", ["get", "kind"], ["river", "canal"], 1, 0.4],
          16,
          ["match", ["get", "kind"], ["river", "canal"], 6, 1.5],
        ],
      },
    },
    {
      id: "buildings",
      type: "fill",
      source: SRC,
      "source-layer": "buildings",
      minzoom: 14,
      paint: {
        "fill-color": p.building,
        "fill-outline-color": p.buildingLine,
      },
    },
    {
      id: "boundaries",
      type: "line",
      source: SRC,
      "source-layer": "boundaries",
      filter: [
        "all",
        ["<=", ["get", "admin_level"], 4],
        ["!=", ["get", "maritime"], true],
      ],
      paint: {
        "line-color": p.boundary,
        "line-width": ["match", ["get", "admin_level"], 2, 1, 0.6],
        "line-dasharray": [3, 2],
        "line-opacity": 0.7,
      },
    },
    {
      id: "rail",
      type: "line",
      source: SRC,
      "source-layer": "streets",
      minzoom: 10,
      filter: ["==", ["get", "kind"], "rail"],
      paint: {
        "line-color": p.rail,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 1.5],
        "line-dasharray": [4, 3],
      },
    },
    {
      id: "streets-casing",
      type: "line",
      source: SRC,
      "source-layer": "streets",
      minzoom: 11,
      filter: [
        "all",
        ["in", ["get", "kind"], ["literal", [...MAJOR, ...MINOR]]],
        ["!=", ["get", "tunnel"], true],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.casing,
        "line-width": streetWidth(1),
        "line-gap-width": 0,
      },
    },
    {
      id: "paths",
      type: "line",
      source: SRC,
      "source-layer": "streets",
      minzoom: 14,
      filter: [
        "in",
        ["get", "kind"],
        [
          "literal",
          ["footway", "path", "cycleway", "track", "steps", "bridleway"],
        ],
      ],
      paint: {
        "line-color": p.casing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 18, 2],
        "line-dasharray": [2, 1.5],
      },
    },
    {
      id: "streets",
      type: "line",
      source: SRC,
      "source-layer": "streets",
      filter: ["in", ["get", "kind"], ["literal", [...MAJOR, ...MINOR]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "match",
          ["get", "kind"],
          ["motorway", "trunk"],
          p.motorway,
          ["primary", "secondary"],
          p.roadMajor,
          p.road,
        ],
        "line-width": streetWidth(),
        "line-opacity": ["case", ["==", ["get", "tunnel"], true], 0.5, 1],
      },
    },
    ...labelLayers(p, text),
  ]
  return { version: 8, name: `Danbyte ${theme}`, sources, layers }
}

const NAME_KEY = /^name(_[a-z]{2,3})?$/

/** True when a `text-field` value reads a feature's name. */
function readsName(v: unknown): boolean {
  if (typeof v === "string") return /\{name(_[a-z]{2,3})?\}/.test(v)
  if (!Array.isArray(v)) return false
  if (v[0] === "get" && typeof v[1] === "string") return NAME_KEY.test(v[1])
  return v.some(readsName)
}

/**
 * A third-party MapLibre style (a style URL in Settings → Maps) with its
 * name labels switched to the setting's language. Other text (refs, house
 * numbers) is left alone. Returns a copy.
 */
export function relabelStyle(
  style: VectorStyle,
  labels: LabelLanguage,
  browser?: readonly string[]
): VectorStyle {
  const text = labelExpression(labels, browser)
  return {
    ...style,
    layers: style.layers.map((l) => {
      const tf = l.layout?.["text-field"]
      if (l.type !== "symbol" || !readsName(tf)) return l
      return { ...l, layout: { ...l.layout, "text-field": text } }
    }),
  }
}

/** What a vector source URL returned: a full style, or a TileJSON whose
 * tiles the bundled style draws. Anything else is an error. The TileJSON's
 * own `attribution` is dropped: the credit shown is Danbyte's setting, never
 * HTML from the tile server. */
export function classifySource(
  json: unknown
):
  | { kind: "style"; style: VectorStyle }
  | { kind: "tilejson"; source: VectorSourceSpec }
  | { kind: "invalid" } {
  if (!json || typeof json !== "object") return { kind: "invalid" }
  const j = json as Record<string, unknown>
  if (j.version === 8 && Array.isArray(j.layers) && j.sources) {
    return { kind: "style", style: j as unknown as VectorStyle }
  }
  const tiles = Array.isArray(j.tiles)
    ? j.tiles.filter(
        (t): t is string => typeof t === "string" && /^https:\/\//.test(t)
      )
    : []
  if (tiles.length === 0) return { kind: "invalid" }
  const source: VectorSourceSpec = { type: "vector", tiles }
  if (typeof j.minzoom === "number") source.minzoom = j.minzoom
  if (typeof j.maxzoom === "number") source.maxzoom = j.maxzoom
  if (Array.isArray(j.bounds) && j.bounds.length === 4) {
    source.bounds = j.bounds.map(Number)
  }
  return { kind: "tilejson", source }
}
