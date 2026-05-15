// Pre-process geometry to remove the two most common kinds of overlapping
// triangles found in BIM / CAD exports of buildings:
//
//   1. Exact-duplicate triangles  - same 3 vertices, any winding.
//   2. Coplanar containment       - a small triangle that lies on the same
//                                   plane (within tolerance) as, and entirely
//                                   inside, a larger one.
//
// What this does NOT solve: arbitrary partial overlaps of coplanar triangles
// (two L-shapes overlapping in a strip, etc.). That needs polygon-clipping
// (boolean union + re-triangulation) which is out of scope here; do it in
// Blender (Mesh → Clean Up → Merge by Distance + Limited Dissolve) before
// loading the OBJ.

export function dedupeOverlaps(positions, indices, opts = {}) {
  const NORMAL_TOL = opts.normalTol ?? 0.01; // cos-angle tolerance for "same normal"
  const OFFSET_TOL = opts.offsetTol ?? 0.01; // world units for "same plane offset"
  const BARY_EPS   = 1e-5;

  const numTris = indices.length / 3;
  if (numTris === 0) return { indices: new Uint32Array(0), removed: 0 };

  // -------- pass 1: exact duplicates by sorted vertex tuple --------
  const removed = new Uint8Array(numTris);
  const seenExact = new Map();
  for (let i = 0; i < numTris; i++) {
    const a = indices[i * 3], b = indices[i * 3 + 1], c = indices[i * 3 + 2];
    // canonical order: smallest index first, then sorted
    let lo = a, mid = b, hi = c;
    if (lo > mid) { const t = lo; lo = mid; mid = t; }
    if (mid > hi) { const t = mid; mid = hi; hi = t; }
    if (lo > mid) { const t = lo; lo = mid; mid = t; }
    const key = lo + ',' + mid + ',' + hi;
    if (seenExact.has(key)) removed[i] = 1;
    else                    seenExact.set(key, i);
  }

  // -------- pass 2: per-triangle plane (normal + offset) and area --------
  const triNX = new Float32Array(numTris);
  const triNY = new Float32Array(numTris);
  const triNZ = new Float32Array(numTris);
  const triD  = new Float32Array(numTris);
  const triA  = new Float32Array(numTris);
  for (let i = 0; i < numTris; i++) {
    const ia = indices[i * 3]     * 3;
    const ib = indices[i * 3 + 1] * 3;
    const ic = indices[i * 3 + 2] * 3;
    const ax = positions[ia],     ay = positions[ia + 1], az = positions[ia + 2];
    const e0x = positions[ib]     - ax;
    const e0y = positions[ib + 1] - ay;
    const e0z = positions[ib + 2] - az;
    const e1x = positions[ic]     - ax;
    const e1y = positions[ic + 1] - ay;
    const e1z = positions[ic + 2] - az;
    const cx = e0y * e1z - e0z * e1y;
    const cy = e0z * e1x - e0x * e1z;
    const cz = e0x * e1y - e0y * e1x;
    const twoArea = Math.hypot(cx, cy, cz);
    if (twoArea < 1e-12) { removed[i] = 1; continue; } // degenerate
    const inv = 1 / twoArea;
    let nx = cx * inv, ny = cy * inv, nz = cz * inv;
    // Make normal direction canonical so opposite-winding triangles bucket
    // together. Flip so that (nx + ny + nz) is positive, breaking ties by nx.
    const s = nx + ny + nz;
    if (s < 0 || (s === 0 && nx < 0)) { nx = -nx; ny = -ny; nz = -nz; }
    triNX[i] = nx; triNY[i] = ny; triNZ[i] = nz;
    triD[i]  = nx * ax + ny * ay + nz * az;
    triA[i]  = twoArea * 0.5;
  }

  // -------- pass 3: bucket by quantised plane --------
  const buckets = new Map();
  for (let i = 0; i < numTris; i++) {
    if (removed[i]) continue;
    const kNX = Math.round(triNX[i] / NORMAL_TOL);
    const kNY = Math.round(triNY[i] / NORMAL_TOL);
    const kNZ = Math.round(triNZ[i] / NORMAL_TOL);
    const kD  = Math.round(triD[i]  / OFFSET_TOL);
    const key = kNX + '_' + kNY + '_' + kNZ + '_' + kD;
    let g = buckets.get(key);
    if (!g) { g = []; buckets.set(key, g); }
    g.push(i);
  }

  // -------- pass 4: within each coplanar bucket, drop small triangles
  //                  that are fully contained in larger ones --------
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    // sort by area ascending so we test small-vs-big
    group.sort((a, b) => triA[a] - triA[b]);

    // build 2D basis from the bucket's reference normal
    const ref = group[group.length - 1]; // pick largest tri's normal as basis seed
    const nx = triNX[ref], ny = triNY[ref], nz = triNZ[ref];
    // pick a world axis not parallel to the normal
    let rx = 1, ry = 0, rz = 0;
    if (Math.abs(nx) > 0.9) { rx = 0; ry = 1; rz = 0; }
    // u = ref × n, normalised
    let ux = ry * nz - rz * ny;
    let uy = rz * nx - rx * nz;
    let uz = rx * ny - ry * nx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    // v = n × u
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    // pre-project every triangle's vertices to (u, v)
    const proj = new Float32Array(group.length * 6);
    for (let gi = 0; gi < group.length; gi++) {
      const t = group[gi];
      for (let k = 0; k < 3; k++) {
        const p = indices[t * 3 + k] * 3;
        const x = positions[p], y = positions[p + 1], z = positions[p + 2];
        proj[gi * 6 + k * 2 + 0] = x * ux + y * uy + z * uz;
        proj[gi * 6 + k * 2 + 1] = x * vx + y * vy + z * vz;
      }
    }

    for (let gi = 0; gi < group.length; gi++) {
      const small = group[gi];
      if (removed[small]) continue;
      const sx0 = proj[gi * 6 + 0], sy0 = proj[gi * 6 + 1];
      const sx1 = proj[gi * 6 + 2], sy1 = proj[gi * 6 + 3];
      const sx2 = proj[gi * 6 + 4], sy2 = proj[gi * 6 + 5];

      for (let gj = gi + 1; gj < group.length; gj++) {
        const big = group[gj];
        if (removed[big]) continue;
        const bx0 = proj[gj * 6 + 0], by0 = proj[gj * 6 + 1];
        const bx1 = proj[gj * 6 + 2], by1 = proj[gj * 6 + 3];
        const bx2 = proj[gj * 6 + 4], by2 = proj[gj * 6 + 5];

        if (pointInTri2(sx0, sy0, bx0, by0, bx1, by1, bx2, by2, BARY_EPS) &&
            pointInTri2(sx1, sy1, bx0, by0, bx1, by1, bx2, by2, BARY_EPS) &&
            pointInTri2(sx2, sy2, bx0, by0, bx1, by1, bx2, by2, BARY_EPS)) {
          removed[small] = 1;
          break;
        }
      }
    }
  }

  // -------- pass 5: pack surviving triangles --------
  let count = 0;
  for (let i = 0; i < numTris; i++) if (removed[i]) count++;
  const kept = new Uint32Array((numTris - count) * 3);
  let w = 0;
  for (let i = 0; i < numTris; i++) {
    if (removed[i]) continue;
    kept[w++] = indices[i * 3];
    kept[w++] = indices[i * 3 + 1];
    kept[w++] = indices[i * 3 + 2];
  }
  return { indices: kept, removed: count };
}

function pointInTri2(px, py, ax, ay, bx, by, cx, cy, eps) {
  // Standard barycentric test in 2D.
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-20) return false;
  const inv = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -eps && v >= -eps && u + v <= 1 + eps;
}
