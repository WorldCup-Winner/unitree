# OBJ Walkable Area Viewer (Recast/Detour)

A three.js web viewer for `.obj` files that:

1. Runs the **real Recast/Detour pipeline** in the browser via
   [recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js)
   — the same C++ project at `..\researching\recastnavigation\` compiled to
   WebAssembly. Every algorithm (`rcRasterizeTriangles`, the three filters,
   `rcBuildCompactHeightfield`, `rcErodeWalkableArea`, region/contour/polymesh
   build, and `dtNavMeshQuery::findPath` + `findStraightPath`) is the wasm
   binary, not a JS reimplementation.
2. **Classifies the original OBJ triangles** as walkable / stairs /
   non-walkable by sampling the Recast heightfield, so the colours you see are
   the *original* mesh pieces — no new geometry is generated for display.
3. Lets you click anywhere on the walkable surface to set the start and end
   points, then draws Detour's straight-path output as a dark-green line.

## Colours

| Layer                  | Colour              |
|------------------------|---------------------|
| Original mesh (all)    | transparent blue    |
| Walkable triangles     | white               |
| Stair triangles        | red                 |
| Start / end markers    | dark green sphere   |
| Path                   | dark green polyline |

## Pipeline (matches the C++ in `Sample_SoloMesh.cpp`)

1. Parse `.obj` → flat `positions[]`, `indices[]` (matches
   `InputGeom::loadMesh` in
   [RecastDemo/Source/InputGeom.cpp](../researching/recastnavigation/RecastDemo/Source/InputGeom.cpp)).
2. `generateSoloNavMesh(positions, indices, cfg, keepIntermediates=true)`
   internally runs, in order: `rcCreateHeightfield`,
   `rcMarkWalkableTriangles`, `rcRasterizeTriangles`,
   `rcFilterLowHangingWalkableObstacles`, `rcFilterLedgeSpans`,
   `rcFilterWalkableLowHeightSpans`, `rcBuildCompactHeightfield`,
   `rcErodeWalkableArea`, `rcBuildDistanceField`, `rcBuildRegions`,
   `rcBuildContours`, `rcBuildPolyMesh`, `rcBuildPolyMeshDetail`, then
   `dtCreateNavMeshData` + `dtNavMesh::init`.
3. The returned `intermediates.heightfield` (a `RecastHeightfield`) is walked
   per column to classify each original input triangle:
   - find the heightfield column containing the triangle's centroid in XZ;
   - find the span whose top (`smax`) is closest to the centroid's Y;
   - if `area != RC_NULL_AREA` → **walkable**;
   - if the span just below in the same column is also walkable and the
     `smax` delta lies in `(0, walkableClimb]` → **stairs**. That delta is
     exactly the pattern `rcFilterLowHangingWalkableObstacles` recovers, so a
     triangle landing on the upper span of such a pair sat on a "low-hanging
     recovered" voxel — which is the closest thing Recast has to a stair
     classification.
4. Path queries call `NavMeshQuery.computePath(start, end)` which under the
   hood is `dtNavMeshQuery::findNearestPoly` → `findPath` (A* over the poly
   graph) → `findStraightPath` (funnel / string-pulling). The returned
   waypoints are drawn as a single line.

## Run it

ES module imports from a CDN need an HTTP origin (browsers refuse module
loads from `file://`):

```powershell
# inside the project folder
python -m http.server 8000
# then open http://localhost:8000
```

…or the **Live Server** extension in VS Code (right-click `index.html` →
"Open with Live Server"). First load downloads the Recast WASM (~1 MB).

## Demo meshes

`..\researching\recastnavigation\RecastDemo\Bin\Meshes\` ships with:

- `nav_test.obj` — stairs, ramps, ledges — best for seeing the red colouring
- `dungeon.obj`  — bigger map with rooms and corridors
- `undulating.obj` — open rolling terrain

## Controls

- Drag = orbit • right-drag = pan • scroll = zoom
- **Set Start** → click any white/red triangle
- **Set End**   → click another; Detour computes the path and the line appears
- Adjust **Recast config** sliders and press **Build navmesh** to rerun the pipeline

## Project layout

```
obj-nav-viewer/
├── index.html        — UI shell + importmap (three, recast-navigation@0.43.1)
├── style.css         — sidebar / canvas layout
├── js/
│   ├── main.js       — wiring: file load → build → render → click → path
│   ├── objParser.js  — minimal OBJ reader (v + f only, mirrors InputGeom.cpp)
│   ├── navMesh.js    — recast-navigation wrapper + heightfield classification
│   └── viewer.js     — three.js scene, raycasting, markers, path line
└── README.md
```
