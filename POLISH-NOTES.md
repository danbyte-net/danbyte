# Floor plan polish notes

## Done (commits d2f2e5dc, f3113e98, 993f0714, merged with dev/v0.19.0)

- 2D: Display > Muted background (default on; inverted on dark), one foldable
  legend card (export skips its button), trays as channels, linked tiles on a
  solid base, alarm ring, area names with halo and mixed ink, cable/tray names
  kept off tiles, nameless areas listed as "Area · N m²".
- 3D: theme-aware slab with edge, light walls with edge lines, distance-faded
  grid, muted floor texture (not tone-mapped), area tints with outlines,
  page-coloured name plates.
- Docs: docs/features/floor-plans.md, docs/design/visual-language.md.
- Gates passed: build, typecheck, vitest floorplan + floorplan3d, prettier,
  zensical build.

## Next

- PDF background muting lives server-side (api/floor_plan_pdf.py) - not done.
- Area names are world-sized; move them to the screen-size label pass.
- 3D: sidebar click does not select/fly to a rack.
- Review hover/selection colours, 2D grid, stub arrows.
- No headless frame-time measurement yet.

## Screenshots

/tmp/claude-1001/-home-crosk-danbyte/a1483f90-0add-4c8c-b29c-3ee6cee28a1f/scratchpad/polish/
(before-*, a1-*/a2-* 2D after, b1-*/b2-* 3D after, c1-* other plans;
shot.py is the Playwright script).
