// Minimal OBJ parser. Mirrors RecastDemo/Source/InputGeom.cpp readFromObj:
// - "v x y z" -> vertex position (vn, vt are ignored)
// - "f ..."   -> face (1-based indices; negative = relative; '/' separators handled)
//               Polygons are fan-triangulated as (face[0], face[i-1], face[i]).
// Output: { verts: Float32Array, tris: Uint32Array }

export function parseObj(text) {
  const verts = [];
  const tris = [];

  const lines = text.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx];
    if (!raw) continue;
    // Strip comment portion
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line) continue;

    if (line[0] === 'v' && line[1] === ' ') {
      const parts = line.split(/\s+/);
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        verts.push(x, y, z);
      }
      continue;
    }

    if (line[0] === 'f' && (line[1] === ' ' || line[1] === '\t')) {
      const tokens = line.split(/\s+/).slice(1);
      const vertCount = verts.length / 3;
      const face = [];
      for (const tok of tokens) {
        if (!tok) continue;
        // "v", "v/vt", "v//vn", "v/vt/vn" -> we want only the position index
        const posTok = tok.split('/')[0];
        const idx = parseInt(posTok, 10);
        if (!Number.isFinite(idx)) continue;
        const zeroBased = idx < 0 ? idx + vertCount : idx - 1;
        if (zeroBased < 0 || zeroBased >= vertCount) continue;
        face.push(zeroBased);
      }
      // Fan triangulate the polygon
      for (let i = 2; i < face.length; i++) {
        tris.push(face[0], face[i - 1], face[i]);
      }
      continue;
    }
    // Everything else (vn, vt, g, o, s, usemtl, mtllib, ...) is intentionally ignored.
  }

  return {
    verts: new Float32Array(verts),
    tris:  new Uint32Array(tris),
  };
}
