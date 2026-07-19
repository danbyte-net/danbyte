import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /custom-field-groups branch.
export const Route = createFileRoute("/custom-field-groups")({
  component: () => <Outlet />,
})
