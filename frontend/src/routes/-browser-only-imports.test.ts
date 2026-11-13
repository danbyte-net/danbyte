import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

// The frontend server renders every route, so a module a route imports
// statically is loaded by Node. Leaflet (and its plugins) reads `window` as
// it loads and xterm's CommonJS build has no named exports there: either one
// in a route's static import graph fails the server render, and a failed
// load of Leaflet took the whole frontend process down. Those modules load
// through a dynamic import (lazyChunk) behind ClientOnly instead.

const BROWSER_ONLY =
  /^(leaflet|leaflet\.[\w-]+|@maplibre\/maplibre-gl-leaflet|@xterm\/[\w-]+)(\/|$)/

const SRC = resolve(__dirname, "..")
const ROUTES = join(SRC, "routes")

// Static imports and re-exports, multi-line ones included; `import type` is
// erased, dynamic `import()` is the client-only path and is not matched.
const STATIC =
  /^\s*(?:import|export)\s+(type\s+)?(?:[\w*$\s{},]*?\s*from\s*)?["']([^"']+)["']/gm

const parsed = new Map<string, string[]>()
function staticImports(file: string): string[] {
  let specs = parsed.get(file)
  if (!specs) {
    const text = readFileSync(file, "utf8")
    specs = [...text.matchAll(STATIC)].filter((m) => !m[1]).map((m) => m[2])
    parsed.set(file, specs)
  }
  return specs
}

function resolveLocal(from: string, spec: string): string | null {
  const bare = spec.split("?")[0]
  const base = bare.startsWith("@/")
    ? join(SRC, bare.slice(2))
    : resolve(dirname(from), bare)
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + ext
    if (/\.tsx?$/.test(p) && existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

/** The first chain from `entry` to a browser-only package, or null. */
function browserOnlyChain(entry: string): string[] | null {
  const prev = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()!
    for (const spec of staticImports(file)) {
      if (BROWSER_ONLY.test(spec)) {
        const chain = [spec]
        for (let n: string | null = file; n; n = prev.get(n) ?? null)
          chain.unshift(relative(SRC, n))
        return chain
      }
      if (!spec.startsWith(".") && !spec.startsWith("@/")) continue
      const next = resolveLocal(file, spec)
      if (next && !prev.has(next)) {
        prev.set(next, file)
        queue.push(next)
      }
    }
  }
  return null
}

const entries = [
  join(SRC, "router.tsx"),
  join(SRC, "server.ts"),
  ...readdirSync(ROUTES)
    .filter((n) => /\.tsx?$/.test(n) && !/\.test\.|routeTree\.gen/.test(n))
    .map((n) => join(ROUTES, n)),
]

describe("browser-only libraries stay out of the server render", () => {
  it("finds the routes and follows their imports", () => {
    expect(entries.length).toBeGreaterThan(100)
    // The scan is live: the map page itself is what loads Leaflet.
    expect(
      browserOnlyChain(join(SRC, "components/site-map/site-map-page.tsx"))
    ).not.toBeNull()
  })

  it("no route imports Leaflet or xterm statically", () => {
    const chains = entries
      .map(browserOnlyChain)
      .filter((c): c is string[] => c !== null)
      .map((c) => c.join(" -> "))
    expect(chains).toEqual([])
  })

  // After `npm run build`: the same rule on the server bundle itself. A
  // route's server chunk is named after its file (`devices.$id.tsx` ->
  // `devices._id-<hash>.js`); the lazy map and terminal chunks import the
  // packages, but neither the entry nor a route chunk may reach one through
  // static imports.
  const assets = resolve(SRC, "../dist/server/assets")
  it.skipIf(!existsSync(assets))("holds for the built server chunks", () => {
    const FROM = /^\s*import\s*(?:[\w*$\s{},]*?\s*from\s*)?["']([^"']+)["']/gm
    const files = readdirSync(assets).filter((f) => f.endsWith(".js"))
    const deps = new Map(
      files.map((f) => [
        f,
        [...readFileSync(join(assets, f), "utf8").matchAll(FROM)].map(
          (m) => m[1]
        ),
      ])
    )
    deps.set(
      "../server.js",
      [
        ...readFileSync(join(assets, "../server.js"), "utf8").matchAll(FROM),
      ].map((m) => m[1].replace(/^\.\/assets\//, "./"))
    )
    const reaches = (start: string): string | null => {
      const prev = new Map<string, string | null>([[start, null]])
      const queue = [start]
      while (queue.length) {
        const cur = queue.shift()!
        for (const d of deps.get(cur) ?? []) {
          if (BROWSER_ONLY.test(d)) {
            const chain = [d]
            for (let n: string | null = cur; n; n = prev.get(n) ?? null)
              chain.unshift(n)
            return chain.join(" -> ")
          }
          const next = d.replace(/^\.\//, "")
          if (d.startsWith("./") && !prev.has(next)) {
            prev.set(next, cur)
            queue.push(next)
          }
        }
      }
      return null
    }
    const routeNames = new Set(
      entries.map((e) =>
        relative(ROUTES, e)
          .replace(/\.tsx?$/, "")
          .replaceAll("$", "_")
      )
    )
    const starts = [
      "../server.js",
      ...files.filter((f) => routeNames.has(f.replace(/-[\w-]{8}\.js$/, ""))),
    ]
    expect(starts.length).toBeGreaterThan(100)
    const offenders = starts.map(reaches).filter((c) => c !== null)
    expect(offenders).toEqual([])
  })
})
