// The frontend server's entry: Start's own handler, with a script nonce and
// the Content-Security-Policy for it on every HTML page (#498).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import handler, { createServerEntry } from "@tanstack/react-start/server-entry"
import { newNonce, parseCspMode, withCspHeaders } from "@/lib/csp-policy"
import type { CspMode } from "@/lib/csp-policy"

/**
 * DANBYTE_CSP_MODE from the environment, else from the install's .env (the
 * frontend unit is not given the whole file: it holds the secrets). Read
 * once; a change needs a restart of the frontend.
 */
function configuredMode(): string | undefined {
  const fromEnv = process.env.DANBYTE_CSP_MODE
  if (fromEnv !== undefined) return fromEnv
  try {
    const text = readFileSync(resolve(process.cwd(), "..", ".env"), "utf8")
    // The last assignment wins, as it does for Django's dotenv.
    const all = [
      ...text.matchAll(
        /^\s*DANBYTE_CSP_MODE\s*=\s*["']?([A-Za-z-]*)["']?\s*$/gm
      ),
    ]
    return all.at(-1)?.[1]
  } catch {
    return undefined
  }
}

function resolveMode(): CspMode {
  const raw = configuredMode()
  // The Vite dev server injects its own unnonced scripts: no policy there
  // unless one is asked for.
  const { mode, valid } = import.meta.env.DEV
    ? parseCspMode(raw, "off")
    : parseCspMode(raw)
  if (!valid) {
    console.warn(
      `DANBYTE_CSP_MODE=${JSON.stringify(raw)} is not enforce, report or off; enforcing`
    )
  }
  return mode
}

const mode = resolveMode()

export default createServerEntry({
  async fetch(request) {
    if (mode === "off") return handler.fetch(request)
    const nonce = newNonce()
    const response = await handler.fetch(request, { context: { nonce } })
    return withCspHeaders(response, nonce, mode)
  },
})
