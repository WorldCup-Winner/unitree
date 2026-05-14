import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AREA_NONE, AREA_WALKABLE, AREA_STAIRS } from './navMesh.js';

// Colour palette
const COL_NON_WALKABLE = 0x4a78d6; // blue
const COL_WALKABLE     = 0xffffff; // white
const COL_STAIRS       = 0xd64141; // red
const COL_PATH         = 0x1a6b1a; // black-green
const COL_BG           = 0x1b1d22;

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL_BG);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
    this.camera.position.set(20, 25, 30);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(50, 80, 30);
    this.scene.add(ambient, dir);

    // Groups for built mesh + overlay
    this.nonWalkableMesh = null;
    this.walkableMesh    = null;
    this.stairsMesh      = null;
    this.wireframe       = null;

    // Path & markers
    this.pathLine    = null;
    this.startMarker = null;
    this.endMarker   = null;

    // Triangle index lookup for click picking
    // For each face in a category mesh, what's the original triangle index?
    this.walkableTriMap = new Uint32Array(0);
    this.stairsTriMap   = new Uint32Array(0);

    window.addEventListener('resize', () => this._resize());
    this._resize();
    this._animate();
  }

  _resize() {
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate = () => {
    requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ---------- frame the loaded mesh ----------
  frameBounds(box) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) * 1.2;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.7, radius));
    this.camera.near = Math.max(0.1, radius * 0.001);
    this.camera.far  = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // ---------- build/refresh the visible meshes from classification ----------
  rebuild(verts, tris, areas) {
    // Remove existing
    for (const m of [this.nonWalkableMesh, this.walkableMesh, this.stairsMesh, this.wireframe]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    }
    this.nonWalkableMesh = null;
    this.walkableMesh = null;
    this.stairsMesh = null;
    this.wireframe = null;

    const nonWalkable = this._buildCategoryGeometry(verts, tris, areas, AREA_NONE);
    const walkable    = this._buildCategoryGeometry(verts, tris, areas, AREA_WALKABLE);
    const stairs      = this._buildCategoryGeometry(verts, tris, areas, AREA_STAIRS);

    this.walkableTriMap = walkable.triMap;
    this.stairsTriMap   = stairs.triMap;

    if (nonWalkable.geo) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL_NON_WALKABLE,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.nonWalkableMesh = new THREE.Mesh(nonWalkable.geo, mat);
      this.nonWalkableMesh.userData.category = 'nonwalkable';
      this.scene.add(this.nonWalkableMesh);
    }
    if (walkable.geo) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL_WALKABLE,
        side: THREE.DoubleSide,
        flatShading: true,
      });
      this.walkableMesh = new THREE.Mesh(walkable.geo, mat);
      this.walkableMesh.userData.category = 'walkable';
      this.scene.add(this.walkableMesh);
    }
    if (stairs.geo) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL_STAIRS,
        side: THREE.DoubleSide,
        flatShading: true,
      });
      this.stairsMesh = new THREE.Mesh(stairs.geo, mat);
      this.stairsMesh.userData.category = 'stairs';
      this.scene.add(this.stairsMesh);
    }
  }

  // Build a non-indexed BufferGeometry containing only triangles with the given area,
  // and a parallel mapping from face index back to the original triangle index.
  _buildCategoryGeometry(verts, tris, areas, category) {
    const numTris = areas.length;
    let count = 0;
    for (let i = 0; i < numTris; i++) if (areas[i] === category) count++;
    if (count === 0) return { geo: null, triMap: new Uint32Array(0) };

    const positions = new Float32Array(count * 9);
    const triMap    = new Uint32Array(count);
    let p = 0;
    let f = 0;
    for (let i = 0; i < numTris; i++) {
      if (areas[i] !== category) continue;
      const a = tris[i * 3 + 0] * 3;
      const b = tris[i * 3 + 1] * 3;
      const c = tris[i * 3 + 2] * 3;
      positions[p++] = verts[a    ]; positions[p++] = verts[a + 1]; positions[p++] = verts[a + 2];
      positions[p++] = verts[b    ]; positions[p++] = verts[b + 1]; positions[p++] = verts[b + 2];
      positions[p++] = verts[c    ]; positions[p++] = verts[c + 1]; positions[p++] = verts[c + 2];
      triMap[f++] = i;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    return { geo, triMap };
  }

  // ---------- wireframe toggle ----------
  setWireframe(enabled) {
    if (enabled && !this.wireframe) {
      const all = [];
      for (const m of [this.nonWalkableMesh, this.walkableMesh, this.stairsMesh]) {
        if (m) all.push(m.geometry);
      }
      if (!all.length) return;
      const group = new THREE.Group();
      for (const g of all) {
        const wires = new THREE.LineSegments(
          new THREE.WireframeGeometry(g),
          new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 })
        );
        group.add(wires);
      }
      this.wireframe = group;
      this.scene.add(this.wireframe);
    } else if (!enabled && this.wireframe) {
      this.scene.remove(this.wireframe);
      this.wireframe.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.wireframe = null;
    }
  }

  setVisible(category, visible) {
    const target = {
      nonwalkable: this.nonWalkableMesh,
      walkable: this.walkableMesh,
      stairs: this.stairsMesh,
    }[category];
    if (target) target.visible = visible;
  }

  // ---------- raycast against walkable surfaces only ----------
  // Returns { triIdx, point } or null. triIdx is the *original* OBJ triangle index.
  pickWalkable(normalizedDeviceCoord) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(normalizedDeviceCoord, this.camera);
    const targets = [];
    if (this.walkableMesh) targets.push(this.walkableMesh);
    if (this.stairsMesh)   targets.push(this.stairsMesh);
    if (!targets.length) return null;
    const hits = ray.intersectObjects(targets, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const map = hit.object === this.walkableMesh ? this.walkableTriMap : this.stairsTriMap;
    const triIdx = map[hit.faceIndex];
    return { triIdx, point: hit.point.clone() };
  }

  // ---------- start/end markers + path line ----------
  setMarker(which, point) {
    const ref = which === 'start' ? 'startMarker' : 'endMarker';
    if (this[ref]) {
      this.scene.remove(this[ref]);
      this[ref].geometry.dispose();
      this[ref].material.dispose();
    }
    if (!point) { this[ref] = null; return; }
    const radius = this._estimateMarkerRadius();
    const geo = new THREE.SphereGeometry(radius, 16, 12);
    const mat = new THREE.MeshStandardMaterial({ color: COL_PATH, emissive: 0x002200 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(point).addScaledVector(new THREE.Vector3(0, 1, 0), radius * 0.6);
    this[ref] = mesh;
    this.scene.add(mesh);
  }

  setPath(points /* THREE.Vector3[] or null */) {
    if (this.pathLine) {
      this.scene.remove(this.pathLine);
      this.pathLine.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.pathLine = null;
    }
    if (!points || points.length < 2) return;

    // A hairline THREE.Line (linewidth > 1 is ignored by core WebGL) plus a
    // small sphere at every waypoint. The spheres make the corridor visible
    // even when the camera is far back.
    const group = new THREE.Group();

    const flat = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      flat[i * 3 + 0] = points[i].x;
      flat[i * 3 + 1] = points[i].y;
      flat[i * 3 + 2] = points[i].z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    const mat = new THREE.LineBasicMaterial({ color: COL_PATH, depthTest: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 999;
    group.add(line);

    // Waypoint dots
    const r = this._estimateMarkerRadius() * 0.55;
    const sphereGeo = new THREE.SphereGeometry(r, 12, 8);
    const sphereMat = new THREE.MeshBasicMaterial({ color: COL_PATH, depthTest: false });
    for (let i = 1; i < points.length - 1; i++) {
      const dot = new THREE.Mesh(sphereGeo, sphereMat);
      dot.position.copy(points[i]);
      dot.renderOrder = 999;
      group.add(dot);
    }

    this.pathLine = group;
    this.scene.add(this.pathLine);
  }

  _estimateMarkerRadius() {
    // Use scene bbox to pick a reasonable marker size.
    const box = new THREE.Box3();
    for (const m of [this.walkableMesh, this.stairsMesh, this.nonWalkableMesh]) {
      if (m) box.expandByObject(m);
    }
    if (box.isEmpty()) return 0.2;
    const size = new THREE.Vector3();
    box.getSize(size);
    return Math.max(size.x, size.y, size.z) * 0.018;
  }

  clearAllMarkersAndPath() {
    this.setMarker('start', null);
    this.setMarker('end', null);
    this.setPath(null);
  }
}
