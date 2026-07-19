import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/ipsec-profiles")({
  component: () => <Outlet />,
})
