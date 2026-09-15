import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/as-path-lists")({
  component: () => <Outlet />,
})
