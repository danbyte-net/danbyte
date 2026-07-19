import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/module-types")({
  component: () => <Outlet />,
})
