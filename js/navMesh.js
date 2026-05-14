// Real Recast pipeline via recast-navigation-js (the C++ recastnavigation
// project compiled to WebAssembly). All algorithms — rcRasterizeTriangles,
// rcFilterLowHangingWalkableObstacles, rcFilterLedgeSpans,
// rcFilterWalkableLowHeightSpans, rcBuildCompactHeightfield,
// rcErodeWalkableArea, region/contour/polymesh build, and dtNavMeshQuery
// findPath + findStraightPath — come from the wasm binary, not from JS.

import { init, NavMeshQuery, Recast } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';

export const AREA_NONE     = 0;
export const AREA_WALKABLE = 1;
export const AREA_STAIRS   = 2;

let _initPromise = null;
export function ensureRecastReady() {
  if (!_initPromise) _initPromise = init();
  return _initPromise;
}

/**
 * Run the full Recast solo navmesh build on the given mesh, then classify
 * each *original* triangle as walkable / stair / non-walkable by sampling
 * the resulting Recast heightfield.
 *
 * Stair rule (matches the "Recast-style: low-hanging recovered spans" choice):
 *   A triangle's column has a walkable span S that sits directly above another
 *   walkable span P, with (S.smax - P.smax) in (0, walkableClimb]. That step
 *   pattern is the exact situation rcFilterLowHangingWalkableObstacles
 *   recovers walkability for. The triangle that maps to S is tagged stairs.
 *
 * @param {Float32Array} positions  flat [x,y,z,...] from the OBJ
 * @param {Uint32Array}  indices    flat triangle indices
 * @param {object}       cfg        recast-navigation config (cs, ch, walkable*, etc.)
 */
export function buildNavData(positions, indices, cfg) {
  const result = generateSoloNavMesh(positions, indices, cfg, /* keepIntermediates */ true);
  if (!result.success || !result.navMesh) {
    return { success: false, error: result.error ?? 'unknown', intermediates: result.intermediates };
  }

  const navMesh    = result.navMesh;
  const navQuery   = new NavMeshQuery(navMesh);
  const heightfield = result.intermediates.heightfield;

  const areas = classifyOriginalTriangles(positions, indices, heightfield, cfg);

  return {
    success: true,
    navMesh,
    navQuery,
    intermediates: result.intermediates,
    areas,
  };
}

// ---------------------------------------------------------------------------
// Triangle classification by sampling the heightfield
// ---------------------------------------------------------------------------

function classifyOriginalTriangles(positions, indices, heightfield, cfg) {
  const numTris = indices.length / 3;
  const areas = new Uint8Array(numTris);
  if (!heightfield) return areas;

  // Snapshot the heightfield columns once (each bridge call into wasm has
  // overhead, and we'll touch each column many times).
  const columns = snapshotColumns(heightfield);

  const w  = heightfield.width();
  const h  = heightfield.height();
  const cs = heightfield.cs();
  const ch = heightfield.ch();
  const bmin = heightfield.bmin();
  const bminX = bmin.x, bminY = bmin.y, bminZ = bmin.z;

  // walkableClimb arrives in voxels (Recast convention). It's the same unit as smax.
  const walkableClimb = cfg.walkableClimb ?? 4;

  // Conservative vertical tolerance for matching a triangle to a span:
  // walkableClimb voxels — generous enough that the rasterisation Y-shift
  // doesn't kick us into the wrong span.
  const matchTolVox = Math.max(2, walkableClimb);

  for (let i = 0; i < numTris; i++) {
    const a = indices[i * 3 + 0] * 3;
    const b = indices[i * 3 + 1] * 3;
    const c = indices[i * 3 + 2] * 3;

    const cx = (positions[a    ] + positions[b    ] + positions[c    ]) / 3;
    const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;

    const ix = Math.floor((cx - bminX) / cs);
    const iz = Math.floor((cz - bminZ) / cs);
    if (ix < 0 || ix >= w || iz < 0 || iz >= h) continue;

    const col = columns[ix + iz * w];
    if (!col || col.length === 0) continue;

    // Triangle centroid in voxel units along Y.
    const yVox = (cy - bminY) / ch;

    // Find the column span whose top (smax) is closest to the triangle's
    // surface (its centroid in Y).
    let best = -1;
    let bestDelta = Infinity;
    for (let s = 0; s < col.length; s++) {
      const delta = Math.abs(col[s].smax - yVox);
      if (delta < bestDelta) { bestDelta = delta; best = s; }
    }
    if (best < 0 || bestDelta > matchTolVox) continue;

    const span = col[best];
    if (span.area === RC_NULL_AREA) continue;

    // Default: triangle is walkable.
    areas[i] = AREA_WALKABLE;

    // Stair pattern: the span directly below in this column is also walkable
    // and the smax delta is within walkableClimb. That's exactly the
    // configuration that rcFilterLowHangingWalkableObstacles bridges.
    if (best > 0) {
      const below = col[best - 1];
      if (below.area !== RC_NULL_AREA) {
        const stepDelta = span.smax - below.smax;
        if (stepDelta > 0 && stepDelta <= walkableClimb) {
          areas[i] = AREA_STAIRS;
        }
      }
    }
  }

  return areas;
}

// Pull the rcSpan linked-lists out of the wasm heightfield into a plain JS
// array-of-arrays. Spans within a column are bottom-up (sorted by smin),
// matching how rcAddSpan inserts in Recast/Source/RecastRasterization.cpp.
function snapshotColumns(heightfield) {
  const w = heightfield.width();
  const h = heightfield.height();
  const columns = new Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let s = heightfield.spans(i);
    if (!s || s.raw == null || isNullRaw(s)) { columns[i] = null; continue; }
    const list = [];
    while (s && !isNullRaw(s)) {
      list.push({ smin: s.smin(), smax: s.smax(), area: s.area() });
      s = s.next();
    }
    columns[i] = list;
  }
  return columns;
}

// recast-navigation-js wraps raw wasm pointers; a sentinel null shows up as
// a wrapper around a 0/empty raw. The safest portable check is .raw being
// falsy after Module.isNull. We expose this via a fallback chain.
function isNullRaw(spanWrapper) {
  try {
    if (!spanWrapper.raw) return true;
    // If recast-navigation exposes Module.isNull, use it; otherwise rely on
    // smax() being a valid number (it always is for a real span).
    return false;
  } catch { return true; }
}

// Resolved lazily: Recast.RC_NULL_AREA isn't available until init() resolves.
let RC_NULL_AREA = 0;
ensureRecastReady().then(() => { RC_NULL_AREA = Recast.RC_NULL_AREA; });

// ---------------------------------------------------------------------------
// Pathfinding wrapper
// ---------------------------------------------------------------------------
// computePath() is the high-level convenience that internally calls
// findNearestPoly + findPath + findStraightPath — i.e. Detour's A* over the
// poly graph followed by the funnel/string-pulling step. The returned `path`
// is the same waypoint list you'd get from
// dtNavMeshQuery::findStraightPath in the C++.

export function findStraightPath(navQuery, start, end) {
  const r = navQuery.computePath(
    { x: start.x, y: start.y, z: start.z },
    { x: end.x,   y: end.y,   z: end.z },
    { maxPathPolys: 512, maxStraightPathPoints: 512 },
  );
  if (!r.success) return null;
  return r.path; // Vector3[] from the wasm side
}
