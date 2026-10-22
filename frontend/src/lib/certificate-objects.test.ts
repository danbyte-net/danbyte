import { describe, expect, it } from "vitest"

import { isLetsEncryptDirectory } from "./certificate-objects"

describe("isLetsEncryptDirectory", () => {
  it("matches the production directory by host", () => {
    expect(
      isLetsEncryptDirectory("https://acme-v02.api.letsencrypt.org/directory")
    ).toBe(true)
    expect(
      isLetsEncryptDirectory("https://ACME-V02.api.letsencrypt.org/directory")
    ).toBe(true)
  })

  it("ignores the name elsewhere in the URL", () => {
    for (const url of [
      "https://ca.example.lan/acme-v02.api.letsencrypt.org/directory",
      "https://acme-v02.api.letsencrypt.org.example.lan/directory",
      "https://ca.example.lan/directory?acme-v02.api.letsencrypt.org",
      "https://acme-staging-v02.api.letsencrypt.org/directory",
      "not a url",
    ]) {
      expect(isLetsEncryptDirectory(url)).toBe(false)
    }
  })
})
