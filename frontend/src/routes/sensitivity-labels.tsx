import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /sensitivity-labels branch (Customize →
// Sensitivity labels). The list lives in sensitivity-labels.index.tsx.
export const Route = createFileRoute("/sensitivity-labels")({
  component: () => <Outlet />,
})
