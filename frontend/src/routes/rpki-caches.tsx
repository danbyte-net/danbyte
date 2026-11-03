import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/rpki-caches")({
  component: () => <Outlet />,
})
