import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/config-bundles")({
  component: () => <Outlet />,
})
