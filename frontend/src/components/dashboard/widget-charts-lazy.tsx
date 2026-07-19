// Lazy boundary for the chart widgets. They pull in `recharts` (~375 KB), which
// would otherwise sit in the dashboard's critical path and delay first paint.
// Importing them through React.lazy moves recharts to a chunk that loads AFTER
// the stat band + text have rendered. All seven share one dynamic import, so
// recharts is still fetched only once.
import { lazy } from "react"

const mod = () => import("./widget-charts")

export const DistDonut = lazy(() =>
  mod().then((m) => ({ default: m.DistDonut }))
)
export const DistBar = lazy(() => mod().then((m) => ({ default: m.DistBar })))
export const RadialGauge = lazy(() =>
  mod().then((m) => ({ default: m.RadialGauge }))
)
export const TopPrefixes = lazy(() =>
  mod().then((m) => ({ default: m.TopPrefixes }))
)
export const ObjectCounts = lazy(() =>
  mod().then((m) => ({ default: m.ObjectCounts }))
)
export const RecentActivity = lazy(() =>
  mod().then((m) => ({ default: m.RecentActivity }))
)
