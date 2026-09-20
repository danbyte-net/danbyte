import { api, type FacePorts } from "@/lib/api"

/** How long a first request waits for company before the batch goes out.
 * A rack's devices mount within a frame or two of each other, so one short
 * wait turns forty round trips into one. */
const WINDOW_MS = 25
/** Largest batch the endpoint accepts. */
const MAX_IDS = 200

interface Pending {
  resolve: (v: FacePorts) => void
  reject: (e: unknown) => void
}

let queue = new Map<string, Pending[]>()
let timer: ReturnType<typeof setTimeout> | null = null

async function flush() {
  timer = null
  const batch = queue
  queue = new Map()
  const ids = Array.from(batch.keys())
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const chunk = ids.slice(i, i + MAX_IDS)
    try {
      const out = await api<Record<string, FacePorts>>(
        `/api/devices/face-ports/?ids=${chunk.join(",")}`
      )
      for (const id of chunk) {
        const got = out[id]
        for (const p of batch.get(id) ?? []) {
          if (got) p.resolve(got)
          else p.reject(new Error(`face-ports: ${id} not returned`))
        }
      }
    } catch (e) {
      for (const id of chunk) for (const p of batch.get(id) ?? []) p.reject(e)
    }
  }
}

/** The same answer as `GET /api/devices/{id}/face-ports/`, fetched through
 * the bulk endpoint together with every other device asked for in the same
 * short window. Each caller still gets its own promise, so a per-device
 * query cache works unchanged. */
export function fetchFacePortsBatched(deviceId: string): Promise<FacePorts> {
  return new Promise<FacePorts>((resolve, reject) => {
    const list = queue.get(deviceId) ?? []
    list.push({ resolve, reject })
    queue.set(deviceId, list)
    if (timer == null) timer = setTimeout(() => void flush(), WINDOW_MS)
  })
}
