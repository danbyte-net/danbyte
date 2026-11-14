import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /dependency-media branch (DCIM → Devices →
// Dependency media). The list lives in dependency-media.index.tsx.
export const Route = createFileRoute("/dependency-media")({
  component: () => <Outlet />,
})
