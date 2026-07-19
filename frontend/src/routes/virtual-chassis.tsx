import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/virtual-chassis")({
  component: () => <Outlet />,
})
