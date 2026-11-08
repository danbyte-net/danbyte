import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/cooling-feeds")({
  component: () => <Outlet />,
})
