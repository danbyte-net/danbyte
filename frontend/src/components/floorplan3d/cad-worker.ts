/// <reference lib="webworker" />
/**
 * STEP / IGES → triangle meshes, off the main thread. OpenCascade compiled
 * to WebAssembly (occt-import-js) is several megabytes and a big part can
 * take seconds to mesh, so it runs here, loaded only when a CAD file is
 * picked. The .wasm ships with the app (Vite emits it as an asset) and is
 * handed to the module as bytes - nothing is fetched from anywhere else.
 */
import occtimportjs from "occt-import-js"
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url"

import type { OcctResult } from "./model-convert"

export interface CadRequest {
  format: "step" | "iges"
  buffer: ArrayBuffer
}

export type CadReply =
  { ok: true; result: OcctResult } | { ok: false; error: string }

let occt: ReturnType<typeof occtimportjs> | null = null

async function load() {
  if (!occt) {
    occt = fetch(wasmUrl)
      .then((r) => r.arrayBuffer())
      .then((wasmBinary) => occtimportjs({ wasmBinary }))
  }
  return occt
}

self.onmessage = async (ev: MessageEvent<CadRequest>) => {
  const reply = (msg: CadReply) =>
    (self as DedicatedWorkerGlobalScope).postMessage(msg)
  try {
    const lib = await load()
    const bytes = new Uint8Array(ev.data.buffer)
    // Millimetres out, whatever the file was authored in: the card's unit
    // choice then starts from mm for every CAD file.
    const params = { linearUnit: "millimeter" }
    const result =
      ev.data.format === "iges"
        ? lib.ReadIgesFile(bytes, params)
        : lib.ReadStepFile(bytes, params)
    if (!result.success) {
      reply({ ok: false, error: "The CAD file could not be read." })
      return
    }
    reply({ ok: true, result })
  } catch (e) {
    reply({
      ok: false,
      error: e instanceof Error ? e.message : "The CAD file could not be read.",
    })
  }
}
