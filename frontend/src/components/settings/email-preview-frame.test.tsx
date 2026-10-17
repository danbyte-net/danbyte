// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"

import { EmailPreviewFrame, previewSrcDoc } from "./email-preview-frame"

// The email template preview is rendered from fetched HTML via srcdoc, so a
// reverse proxy's server-wide framing headers cannot blank it (#401).

const { apiTextMock } = vi.hoisted(() => ({
  apiTextMock: vi.fn<(path: string) => Promise<string>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  apiText: apiTextMock,
}))

afterEach(cleanup)
beforeEach(() => {
  apiTextMock.mockReset()
})

function renderFrame(template = "signin_code") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EmailPreviewFrame template={template} />
    </QueryClientProvider>
  )
}

const MAIL =
  '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head>' +
  "<body><p>Your sign-in code</p></body></html>"

describe("EmailPreviewFrame", () => {
  it("fetches the template and renders it via srcdoc, not src", async () => {
    apiTextMock.mockResolvedValue(MAIL)
    renderFrame()
    const frame = await screen.findByTitle("Email preview")
    expect(apiTextMock).toHaveBeenCalledWith(
      "/api/deployment/email/templates/signin_code/"
    )
    expect(frame.getAttribute("src")).toBeNull()
    expect(frame.getAttribute("srcdoc")).toContain("Your sign-in code")
  })

  it("keeps the frame sandboxed without scripts", async () => {
    apiTextMock.mockResolvedValue(MAIL)
    renderFrame()
    const frame = await screen.findByTitle("Email preview")
    const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/)
    expect(frame.hasAttribute("sandbox")).toBe(true)
    expect(tokens).not.toContain("allow-scripts")
    expect(tokens).not.toContain("allow-forms")
    expect(tokens).not.toContain("allow-top-navigation")
    expect(tokens).not.toContain("allow-popups")
  })

  it("carries the endpoint's CSP inside the document", async () => {
    apiTextMock.mockResolvedValue(MAIL)
    renderFrame()
    const frame = await screen.findByTitle("Email preview")
    expect(frame.getAttribute("srcdoc")).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`
    )
  })

  it("shows the API error instead of an empty frame", async () => {
    const { ApiError } = await import("@/lib/api")
    apiTextMock.mockImplementation(async () => {
      throw new ApiError(403, null, "denied")
    })
    renderFrame()
    expect(
      await screen.findByText("You don't have permission to view this.")
    ).toBeTruthy()
    expect(screen.queryByTitle("Email preview")).toBeNull()
  })
})

describe("previewSrcDoc", () => {
  const meta = '<meta http-equiv="Content-Security-Policy"'

  it("puts the policy first in a head with attributes", () => {
    const out = previewSrcDoc(
      '<html><head lang="en"><style>p{}</style></head></html>'
    )
    expect(out.indexOf(meta)).toBe('<html><head lang="en">'.length)
  })

  it("keeps the doctype first when there is no head", () => {
    const out = previewSrcDoc("<!doctype html><p>hi</p>")
    expect(out.startsWith("<!doctype html>" + meta)).toBe(true)
  })

  it("prefixes a bare fragment", () => {
    expect(previewSrcDoc("<p>hi</p>").startsWith(meta)).toBe(true)
  })

  it("does not mistake <header> for <head>", () => {
    const out = previewSrcDoc("<!doctype html><header>x</header>")
    expect(out.startsWith("<!doctype html>" + meta)).toBe(true)
  })
})
