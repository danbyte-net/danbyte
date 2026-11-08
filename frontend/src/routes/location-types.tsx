import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /location-types branch (Organization →
// Location types). The list lives in location-types.index.tsx.
export const Route = createFileRoute("/location-types")({
  component: () => <Outlet />,
})
