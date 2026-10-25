import { lazy, Suspense } from "react"

import type { Application } from "@/lib/api"
import { Loading } from "@/components/loading"

// The application's Diagram tab (#163): the Application map (Maps →
// Application map) embedded and filtered to this application - its flows,
// or its place in the application tree with its hosts - drawn by the
// topology Diagram's engine in the page's own theme. Loaded lazily, so
// React Flow stays out of the application page's bundle.

const EmbeddedAppMap = lazy(() =>
  import("@/components/application-map/embedded").then((m) => ({
    default: m.EmbeddedAppMap,
  }))
)

export function ApplicationFlowDiagram({ app }: { app: Application }) {
  return (
    <Suspense fallback={<Loading />}>
      <EmbeddedAppMap app={app} />
    </Suspense>
  )
}
