import * as THREE from 'three';
import { parseObj } from './objParser.js';
import {
  ensureRecastReady,
  buildNavData,
  findStraightPath,
  AREA_NONE, AREA_WALKABLE, AREA_STAIRS,
} from './navMesh.js';
import { Viewer } from './viewer.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const fileInput   = $('fileInput');
const filenameEl  = $('filename');
const csSlider    = $('cs');
const slopeSlider = $('walkableSlopeAngle');
const whSlider    = $('walkableHeight');
const wcSlider    = $('walkableClimb');
const wrSlider    = $('walkableRadius');
const fixWindingCb = $('fixWinding');
const csVal       = $('csVal');
const slopeVal    = $('slopeVal');
const whVal       = $('whVal');
const wcVal       = $('wcVal');
const wrVal       = $('wrVal');
const rebuildBtn  = $('rebuildBtn');
const modeStart   = $('modeStart');
const modeEnd     = $('modeEnd');
const clearBtn    = $('clearBtn');
const statusEl    = $('status');
const showOriginal = $('showOriginal');
const showWalkable = $('showWalkable');
const showStairs   = $('showStairs');
const showEdges    = $('showEdges');
const statsEl      = $('stats');
const cursorHint   = $('cursorHint');
const bootMessage  = $('bootMessage');

const canvas = $('view');
const viewer = new Viewer(canvas);

// Exposed for headless testing / debugging in DevTools.
// Lets a Playwright driver or you in the console reach the scene state.
window.__app = { state: null, viewer, THREE, AREA_WALKABLE };

// ---------- state ----------
const state = {
  mesh: null,         // { verts, tris } from objParser
  nav:  null,         // { navMesh, navQuery, areas, intermediates } from buildNavData
  startPoint: null,   // THREE.Vector3
  endPoint:   null,
  mode: null,         // 'start' | 'end' | null
};
window.__app.state = state;

// ---------- boot ----------
(async () => {
  await ensureRecastReady();
  bootMessage.classList.add('hidden');
  setStatus('ready — load a .obj to begin');
})();

// ---------- file loading ----------
fileInput.addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  filenameEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = async () => {
    await ensureRecastReady();
    loadObjText(reader.result);
  };
  reader.readAsText(file);
});

function loadObjText(text) {
  setStatus('parsing OBJ...');
  const mesh = parseObj(text);
  if (!mesh.verts.length || !mesh.tris.length) {
    setStatus('OBJ has no geometry');
    return;
  }
  state.mesh = mesh;
  state.startPoint = null;
  state.endPoint = null;
  viewer.clearAllMarkersAndPath();

  rebuild();
  // Frame camera on geometry bounds.
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < mesh.verts.length; i += 3) {
    v.set(mesh.verts[i], mesh.verts[i + 1], mesh.verts[i + 2]);
    box.expandByPoint(v);
  }
  viewer.frameBounds(box);
}

// ---------- build navmesh via recast-navigation ----------
function rebuild() {
  if (!state.mesh) return;

  const cfg = {
    cs:                 parseFloat(csSlider.value),
    ch:                 parseFloat(csSlider.value), // keep ch == cs for simplicity
    walkableSlopeAngle: parseFloat(slopeSlider.value),
    walkableHeight:     parseInt(whSlider.value, 10),
    walkableClimb:      parseInt(wcSlider.value, 10),
    walkableRadius:     parseInt(wrSlider.value, 10),
  };

  // Optional pre-pass: flip triangles whose face normal points down. This is
  // a workaround for OBJs with mixed quad winding — Recast's slope test is
  // signed (norm.y > cos(slope)), so downward-facing copies of a flat floor
  // never pass and you see "half a corridor" missing along a diagonal.
  let triData = state.mesh.tris;
  let flipped = 0;
  if (fixWindingCb.checked) {
    const slopeCos = Math.cos(cfg.walkableSlopeAngle * Math.PI / 180);
    const v = state.mesh.verts;
    const t = state.mesh.tris.slice();   // don't mutate the cached parse
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      const ex = v[b] - v[a],     ey = v[b + 1] - v[a + 1], ez = v[b + 2] - v[a + 2];
      const fx = v[c] - v[a],     fy = v[c + 1] - v[a + 1], fz = v[c + 2] - v[a + 2];
      // y-component of (e × f)
      const ny = ez * fx - ex * fz;
      const nl = Math.hypot(ey * fz - ez * fy, ny, ex * fy - ey * fx) || 1;
      if (ny / nl < -slopeCos) {
        const tmp = t[i + 1]; t[i + 1] = t[i + 2]; t[i + 2] = tmp;
        flipped++;
      }
    }
    triData = t;
  }

  setStatus(flipped
    ? `building navmesh (${flipped} downward tri(s) flipped)...`
    : 'building navmesh via recast wasm...');
  const t0 = performance.now();
  const result = buildNavData(state.mesh.verts, triData, cfg);
  const ms = performance.now() - t0;

  if (!result.success) {
    setStatus(`navmesh build failed: ${result.error}`);
    state.nav = null;
    return;
  }
  state.nav = result;

  viewer.rebuild(state.mesh.verts, triData, result.areas);
  applyVisibility();
  if (showEdges.checked) viewer.setWireframe(true);

  const numTris = result.areas.length;
  let walkable = 0, stairs = 0;
  for (const a of result.areas) {
    if (a === AREA_WALKABLE) walkable++;
    else if (a === AREA_STAIRS) stairs++;
  }
  statsEl.innerHTML =
    `<div>triangles: <b>${numTris}</b></div>` +
    `<div>walkable: <b>${walkable}</b></div>` +
    `<div>stairs:&nbsp;&nbsp; <b>${stairs}</b></div>` +
    `<div>build time: <b>${ms.toFixed(0)} ms</b></div>`;

  setStatus(`navmesh ready (${ms.toFixed(0)} ms)`);

  // Re-run path if both endpoints are still set.
  if (state.startPoint && state.endPoint) tryFindPath();
}

function applyVisibility() {
  viewer.setVisible('nonwalkable', showOriginal.checked);
  viewer.setVisible('walkable',    showWalkable.checked);
  viewer.setVisible('stairs',      showStairs.checked);
}

// ---------- slider wiring ----------
const sliderPairs = [
  [csSlider,    csVal,    (v) => Number(v).toFixed(2)],
  [slopeSlider, slopeVal, (v) => v],
  [whSlider,    whVal,    (v) => v],
  [wcSlider,    wcVal,    (v) => v],
  [wrSlider,    wrVal,    (v) => v],
];
for (const [slider, label, fmt] of sliderPairs) {
  slider.addEventListener('input', () => { label.textContent = fmt(slider.value); });
}
rebuildBtn.addEventListener('click', rebuild);
fixWindingCb.addEventListener('change', () => { if (state.mesh) rebuild(); });

for (const cb of [showOriginal, showWalkable, showStairs]) cb.addEventListener('change', applyVisibility);
showEdges.addEventListener('change', () => viewer.setWireframe(showEdges.checked));

function setMode(m) {
  state.mode = state.mode === m ? null : m;
  modeStart.classList.toggle('active', state.mode === 'start');
  modeEnd.classList.toggle('active',   state.mode === 'end');
  if (state.mode) {
    cursorHint.textContent = `Click a white or red surface to set ${state.mode.toUpperCase()}`;
    cursorHint.classList.add('visible');
  } else {
    cursorHint.classList.remove('visible');
  }
}
modeStart.addEventListener('click', () => setMode('start'));
modeEnd.addEventListener('click',   () => setMode('end'));

clearBtn.addEventListener('click', () => {
  state.startPoint = null;
  state.endPoint = null;
  viewer.clearAllMarkersAndPath();
  setMode(null);
  setStatus('cleared');
});

// ---------- click placement ----------
canvas.addEventListener('pointerdown', (ev) => {
  if (!state.mode || !state.nav) return;
  if (ev.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
    -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
  );
  const hit = viewer.pickWalkable(ndc);
  if (!hit) {
    setStatus('click missed the walkable surface');
    return;
  }
  if (state.mode === 'start') {
    state.startPoint = hit.point;
    viewer.setMarker('start', hit.point);
  } else {
    state.endPoint = hit.point;
    viewer.setMarker('end', hit.point);
  }
  setMode(null);
  tryFindPath();
});

// ---------- pathfind via Detour ----------
function tryFindPath() {
  if (!state.startPoint) { setStatus('set a start point'); return; }
  if (!state.endPoint)   { setStatus('set an end point');  return; }
  if (!state.nav) return;

  const t0 = performance.now();
  const path = findStraightPath(state.nav.navQuery, state.startPoint, state.endPoint);
  const ms = performance.now() - t0;

  if (!path || path.length < 2) {
    setStatus('no path found between the two points');
    viewer.setPath(null);
    return;
  }

  // recast-navigation returns waypoints as { x, y, z }. Lift each one slightly
  // above the surface so the line doesn't z-fight the mesh.
  const offset = Math.max(0.02, estimateSceneSize() * 0.0015);
  const pts = path.map(p => new THREE.Vector3(p.x, p.y + offset, p.z));
  viewer.setPath(pts);

  setStatus(`path: ${path.length} waypoints, ${ms.toFixed(1)} ms`);
}

function estimateSceneSize() {
  if (!state.mesh) return 1;
  const v = state.mesh.verts;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i  ] < minX) minX = v[i  ]; if (v[i  ] > maxX) maxX = v[i  ];
    if (v[i+1] < minY) minY = v[i+1]; if (v[i+1] > maxY) maxY = v[i+1];
    if (v[i+2] < minZ) minZ = v[i+2]; if (v[i+2] > maxZ) maxZ = v[i+2];
  }
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}

function setStatus(s) { statusEl.textContent = s; }
