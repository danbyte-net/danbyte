import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /floorplans branch (the Maps section). List
// lives in floorplans.index.tsx; the canvas in floorplans.$id.tsx.
export const Route = createFileRoute("/floorplans")({
  component: () => <Outlet />,
})
