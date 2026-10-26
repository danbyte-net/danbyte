// Shared fixtures for the /prtg sensor table tests (not a test file itself).
import type { ReactNode } from "react"
import { render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"

import type { PrtgConnection, PrtgSensor } from "@/lib/api"

export const CONN = {
  id: "c1",
  name: "lab",
  url: "https://prtg.example.com",
} as PrtgConnection

export function sensor(
  objid: string,
  patch: Partial<PrtgSensor> = {}
): PrtgSensor {
  return {
    id: `s${objid}`,
    connection: "c1",
    connection_name: "lab",
    device: { id: "d1", name: "db-dev01" },
    virtual_machine: null,
    prtg_device: "db-dev01",
    objid,
    name: `Sensor ${objid}`,
    kind: "ping",
    kind_label: "Ping v2",
    status_raw: 3,
    status: "Up",
    state: "up",
    paused: false,
    acknowledged: false,
    message: "OK",
    tags: [],
    active: true,
    last_value: "1 msec",
    last_value_raw: 1,
    unit: "msec",
    interval_seconds: 60,
    uptime_pct: 100,
    downtime_pct: 0,
    priority: 3,
    last_check_at: "2026-10-26T08:00:00Z",
    last_up_at: null,
    last_down_at: null,
    probe_name: "Local Probe",
    group_path: "Lab",
    last_seen_at: "2026-10-26T08:00:00Z",
    url: `https://prtg.example.com/sensor.htm?id=${objid}`,
    device_url: "https://prtg.example.com/device.htm?id=2081",
    channels_at: null,
    ...patch,
  }
}

if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

/** Render ``node`` inside a router and a query client. */
export function mountWithRouter(node: () => ReactNode) {
  const root = createRootRoute({ component: () => <>{node()}</> })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}
