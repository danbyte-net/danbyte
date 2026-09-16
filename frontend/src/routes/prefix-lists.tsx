import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/prefix-lists")({
  component: () => <Outlet />,
})
