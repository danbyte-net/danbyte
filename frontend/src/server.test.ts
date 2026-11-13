import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Start's handler stands in as a page that writes the nonce it was given
// where the router would: on a script and in the csp-nonce meta.
const seen: Array<string | undefined> = []
vi.mock("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: unknown) => entry,
  default: {
    fetch: async (
      request: Request,
      opts?: { context?: { nonce?: string } }
    ) => {
      const nonce = opts?.context?.nonce
      seen.push(nonce)
      if (new URL(request.url).pathname === "/data.json") {
        return Response.json({ ok: true })
      }
      const attr = nonce ? ` nonce="${nonce}"` : ""
      return new Response(
        `<html><head><meta property="csp-nonce" content="${nonce ?? ""}"/>` +
          `<script${attr}>1</script></head></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      )
    },
  },
}))

async function serverWith(mode: string | undefined) {
  vi.resetModules()
  // Empty counts as unset, and keeps a real install's .env out of the test.
  process.env.DANBYTE_CSP_MODE = mode ?? ""
  return (await import("./server")).default as {
    fetch: (r: Request) => Promise<Response>
  }
}

const page = (path = "/devices") =>
  new Request(`http://danbyte.test${path}`, {
    headers: { accept: "text/html" },
  })

const headerNonce = (value: string | null) =>
  /'nonce-([^']+)'/.exec(value ?? "")?.[1]

describe("server entry", () => {
  beforeEach(() => {
    seen.length = 0
  })

  it("puts the page's own nonce in the enforced policy", async () => {
    const server = await serverWith("enforce")
    const res = await server.fetch(page())
    const nonce = headerNonce(res.headers.get("content-security-policy"))
    expect(nonce).toBeTruthy()
    expect(seen).toEqual([nonce])
    const body = await res.text()
    expect(body).toContain(`<script nonce="${nonce}">`)
    expect(body).toContain(`content="${nonce}"`)
    expect(res.headers.get("cache-control")).toBe("private, no-cache")
  })

  it("gives every response a nonce of its own", async () => {
    const server = await serverWith("enforce")
    const nonces = new Set<string | undefined>()
    for (let i = 0; i < 50; i++) {
      const res = await server.fetch(page())
      nonces.add(headerNonce(res.headers.get("content-security-policy")))
    }
    expect(nonces.size).toBe(50)
    expect(new Set(seen).size).toBe(50)
  })

  it("only reports in report mode", async () => {
    const server = await serverWith("report")
    const res = await server.fetch(page())
    expect(res.headers.get("content-security-policy")).toBeNull()
    const nonce = headerNonce(
      res.headers.get("content-security-policy-report-only")
    )
    expect(nonce).toBe(seen[0])
  })

  it("sends no policy and no nonce when off", async () => {
    const server = await serverWith("off")
    const res = await server.fetch(page())
    expect(res.headers.get("content-security-policy")).toBeNull()
    expect(res.headers.get("content-security-policy-report-only")).toBeNull()
    expect(seen).toEqual([undefined])
  })

  it("enforces when the mode is unset or misspelt", async () => {
    vi.stubEnv("DEV", false)
    try {
      for (const mode of [undefined, "reprot"]) {
        const server = await serverWith(mode)
        const res = await server.fetch(page())
        expect(res.headers.get("content-security-policy")).toContain(
          "'strict-dynamic'"
        )
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("is off under the dev server unless asked for", async () => {
    vi.stubEnv("DEV", true)
    try {
      let res = await (await serverWith(undefined)).fetch(page())
      expect(res.headers.get("content-security-policy")).toBeNull()
      res = await (await serverWith("enforce")).fetch(page())
      expect(res.headers.get("content-security-policy")).toContain("'nonce-")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("reads the mode from the install's .env when the unit sets none", async () => {
    const app = mkdtempSync(join(tmpdir(), "csp-env-"))
    mkdirSync(join(app, "frontend"))
    writeFileSync(
      join(app, ".env"),
      "DJANGO_SECRET_KEY=x\nDANBYTE_CSP_MODE=enforce\nDANBYTE_CSP_MODE='report'\n"
    )
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(app, "frontend"))
    try {
      vi.resetModules()
      delete process.env.DANBYTE_CSP_MODE
      const server = (await import("./server")).default as {
        fetch: (r: Request) => Promise<Response>
      }
      const res = await server.fetch(page())
      expect(res.headers.get("content-security-policy")).toBeNull()
      expect(res.headers.get("content-security-policy-report-only")).toContain(
        "'nonce-"
      )
    } finally {
      cwd.mockRestore()
      rmSync(app, { recursive: true, force: true })
    }
  })

  it("adds nothing to a response that is not a page", async () => {
    const server = await serverWith("enforce")
    const res = await server.fetch(page("/data.json"))
    expect(res.headers.get("content-security-policy")).toBeNull()
    expect(res.headers.get("cache-control")).toBeNull()
  })
})
