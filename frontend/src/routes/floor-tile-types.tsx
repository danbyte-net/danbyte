import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /floor-tile-types branch (the Customize →
// Floor tiles palette). List lives in floor-tile-types.index.tsx.
export const Route = createFileRoute("/floor-tile-types")({
  component: () => <Outlet />,
})
