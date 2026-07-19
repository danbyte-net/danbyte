import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /custom-fields branch.
export const Route = createFileRoute("/custom-fields")({
  component: () => <Outlet />,
})
