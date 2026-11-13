import { describe, expect, it } from "vitest"
import {
  CSP_REPORT_URI,
  cspHeaderName,
  cspPolicy,
  newNonce,
  parseCspMode,
  withCspHeaders,
} from "./csp-policy"

const html = (headers: Record<string, string> = {}) =>
  new Response("<!doctype html><html></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  })

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    })
  )

describe("newNonce", () => {
  it("is 128 bits of base64 and new every time", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const n = newNonce()
      expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/)
      expect(atob(n)).toHaveLength(16)
      seen.add(n)
    }
    expect(seen.size).toBe(1000)
  })
})

describe("parseCspMode", () => {
  it("only reports by default", () => {
    expect(parseCspMode(undefined)).toEqual({ mode: "report", valid: true })
    expect(parseCspMode("")).toEqual({ mode: "report", valid: true })
  })

  it("takes the three modes, in any case", () => {
    expect(parseCspMode("report").mode).toBe("report")
    expect(parseCspMode(" OFF ").mode).toBe("off")
    expect(parseCspMode("Enforce").mode).toBe("enforce")
  })

  it("enforces on a value it does not know", () => {
    expect(parseCspMode("of")).toEqual({ mode: "enforce", valid: false })
    expect(parseCspMode("report-only")).toEqual({
      mode: "enforce",
      valid: false,
    })
  })

  it("keeps an explicit fallback for an unset value only", () => {
    expect(parseCspMode(undefined, "off").mode).toBe("off")
    expect(parseCspMode("bogus", "off").mode).toBe("enforce")
  })
})

describe("cspPolicy", () => {
  it("trusts the nonce and what it loads, with the CSP2 fallbacks", () => {
    const d = directives(cspPolicy("abc123+/AB=="))
    expect(d["script-src"]).toEqual([
      "'nonce-abc123+/AB=='",
      "'strict-dynamic'",
      "'self'",
      "'unsafe-inline'",
    ])
    expect(d["worker-src"]).toEqual(["'self'", "blob:"])
    expect(d["object-src"]).toEqual(["'none'"])
    expect(d["base-uri"]).toEqual(["'self'"])
    expect(d["report-uri"]).toEqual([CSP_REPORT_URI])
    // Never unsafe-eval, never a scheme or wildcard source.
    const text = cspPolicy("abc")
    expect(text).not.toContain("unsafe-eval")
    expect(text).not.toMatch(/\s(https?:|\*)(\s|;|$)/)
  })

  it("refuses anything but base64 as a nonce", () => {
    expect(() => cspPolicy("x'; script-src *")).toThrow()
    expect(() => cspPolicy("")).toThrow()
  })
})

describe("withCspHeaders", () => {
  it("enforces on an HTML page and keeps it out of shared caches", () => {
    const r = withCspHeaders(html(), "bm9uY2U=", "enforce")
    expect(r.headers.get("content-security-policy")).toBe(cspPolicy("bm9uY2U="))
    expect(r.headers.get("content-security-policy-report-only")).toBeNull()
    expect(r.headers.get("cache-control")).toBe("private, no-cache")
    expect(r.status).toBe(200)
  })

  it("only reports in report mode", () => {
    const r = withCspHeaders(html(), "bm9uY2U=", "report")
    expect(r.headers.get("content-security-policy")).toBeNull()
    expect(r.headers.get("content-security-policy-report-only")).toBe(
      cspPolicy("bm9uY2U=")
    )
  })

  it("sends nothing when off", () => {
    const source = html()
    expect(withCspHeaders(source, "bm9uY2U=", "off")).toBe(source)
    expect(cspHeaderName("off")).toBeNull()
  })

  it("leaves a response that is not HTML alone", () => {
    const json = Response.json({ error: "x" }, { status: 406 })
    expect(withCspHeaders(json, "bm9uY2U=", "enforce")).toBe(json)
    const empty = new Response(null, {
      status: 307,
      headers: { location: "/" },
    })
    expect(withCspHeaders(empty, "bm9uY2U=", "enforce")).toBe(empty)
  })

  it("keeps a stricter cache header", () => {
    const r = withCspHeaders(
      html({ "cache-control": "no-store" }),
      "bm9uY2U=",
      "enforce"
    )
    expect(r.headers.get("cache-control")).toBe("no-store")
  })

  it("keeps status and the other headers", () => {
    const r = withCspHeaders(
      new Response("nf", {
        status: 404,
        headers: { "content-type": "text/html", "x-other": "1" },
      }),
      "bm9uY2U=",
      "enforce"
    )
    expect(r.status).toBe(404)
    expect(r.headers.get("x-other")).toBe("1")
  })
})
