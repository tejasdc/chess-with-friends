// 3D landing scene — an opened Duchamp Pocket Chess Set (leather bifold
// wallet with hand-painted board on the left flap and cream celluloid
// piece tokens racked on the right flap). Grabbable: the user can drag
// to orbit ±20°; releases back to a slow idle sway. All geometry is
// generated in code; no external assets. Lazy-loaded from AuthScreen
// via React.lazy so unauthed load stays lean.

import { useEffect, useRef } from "react";
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

// Colors match the Duchamp palette in styles.css so the scene sits in
// the same visual world.
// Slightly warmer/lighter than the flat CSS tokens — physically-based
// materials with dark base colors absorb light and read as near-black.
// These are the same hues bumped up ~15% in luminance so they read as
// "leather" and not "shadow" when lit.
const LEATHER_DEEP = new Color("#2a1e12");
const LEATHER = new Color("#4a3320");
const HONEY = new Color("#e2c088");
const COFFEE = new Color("#4a3320");
const CELLULOID = new Color("#f5ecd0");
const INK = new Color("#1a120a");
const BRASS = new Color("#c99a4a");

// Pieces to lay on the board — a subset that reads as "a game in
// progress". Positions in board coordinates (file 0-7, rank 0-7).
type Placement = { file: number; rank: number; glyph: "K" | "Q" | "R" | "B" | "N" | "P"; white: boolean };
const PIECES: Placement[] = [
  { file: 4, rank: 0, glyph: "K", white: true },
  { file: 3, rank: 0, glyph: "Q", white: true },
  { file: 2, rank: 3, glyph: "N", white: true },
  { file: 4, rank: 3, glyph: "P", white: true },
  { file: 2, rank: 5, glyph: "N", white: false },
  { file: 4, rank: 4, glyph: "P", white: false },
  { file: 3, rank: 7, glyph: "Q", white: false },
  { file: 4, rank: 7, glyph: "K", white: false },
  { file: 6, rank: 5, glyph: "B", white: false },
  { file: 1, rank: 2, glyph: "B", white: true },
];

export default function WalletScene() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    disposedRef.current = false;

    const width = mount.clientWidth;
    const height = mount.clientHeight;
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(LEATHER_DEEP, 1);
    mount.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.background = LEATHER_DEEP;

    const camera = new PerspectiveCamera(36, width / height, 0.1, 100);
    // Tilted overhead — reads as an object on a table, seen from where a
    // player would sit.
    camera.position.set(0, 5.2, 7.4);
    camera.lookAt(0, 0, 0);

    // Lighting: brighter overall so the leather reads warm brown, not
    // near-black. Warm key light front-upper-right, ambient fill for
    // shadow richness, brass rim to catch leather edges.
    const ambient = new AmbientLight(0xf4e7c3, 0.75);
    scene.add(ambient);
    const key = new DirectionalLight(0xfff2c6, 1.8);
    key.position.set(4, 8, 6);
    scene.add(key);
    const rim = new DirectionalLight(0xd7a97a, 0.6);
    rim.position.set(-6, 2, -4);
    scene.add(rim);
    const fill = new DirectionalLight(0xfff2c6, 0.4);
    fill.position.set(0, 4, 10);
    scene.add(fill);

    // Root wallet group — child of a tilt anchor so drag orbits from a
    // stable pivot.
    const wallet = new Group();
    scene.add(wallet);

    // Wallet dimensions: the opened bifold is 8 wide × 5 tall
    // (roughly matching the 16×22cm real ratio, slightly compressed).
    const w = 8;
    const d = 5;
    const covT = 0.22; // cover thickness

    const leatherMat = new MeshStandardMaterial({
      color: LEATHER,
      roughness: 0.75,
      metalness: 0.02,
    });
    const leatherEdgeMat = new MeshStandardMaterial({
      color: LEATHER_DEEP,
      roughness: 0.9,
      metalness: 0.0,
    });

    // Left flap (board): a leather slab
    const leftCover = new Mesh(new BoxGeometry(w / 2, covT, d), leatherMat);
    leftCover.position.set(-w / 4, -covT / 2, 0);
    wallet.add(leftCover);
    // Right flap (rack)
    const rightCover = new Mesh(new BoxGeometry(w / 2, covT, d), leatherMat);
    rightCover.position.set(w / 4, -covT / 2, 0);
    wallet.add(rightCover);

    // Spine — the seam where the wallet folds.
    const spine = new Mesh(new BoxGeometry(0.08, covT * 1.2, d), leatherEdgeMat);
    spine.position.set(0, -covT / 2, 0);
    wallet.add(spine);

    // Board — hand-painted honey + coffee squares on the left flap.
    const boardSize = 3.4;
    const boardOffsetX = -w / 4;
    const boardY = 0.01; // sit slightly above the leather
    const sq = boardSize / 8;
    const honeyMat = new MeshStandardMaterial({ color: HONEY, roughness: 0.85 });
    const coffeeMat = new MeshStandardMaterial({ color: COFFEE, roughness: 0.85 });
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        const dark = (f + r) % 2 === 0;
        const sqMesh = new Mesh(new PlaneGeometry(sq, sq), dark ? coffeeMat : honeyMat);
        sqMesh.rotation.x = -Math.PI / 2;
        sqMesh.position.set(
          boardOffsetX - boardSize / 2 + sq / 2 + f * sq,
          boardY,
          -boardSize / 2 + sq / 2 + r * sq,
        );
        wallet.add(sqMesh);
      }
    }

    // Board painted border — a slightly recessed frame around the board.
    const frameThickness = 0.08;
    const frameSize = boardSize + frameThickness * 2;
    const frameMat = new MeshStandardMaterial({ color: LEATHER_DEEP, roughness: 0.95 });
    const frame = new Mesh(new PlaneGeometry(frameSize, frameSize), frameMat);
    frame.rotation.x = -Math.PI / 2;
    frame.position.set(boardOffsetX, -0.001, 0);
    wallet.add(frame);

    // Pieces — flat celluloid discs standing on brass pins. Each disc
    // fills most of its square (0.42 of sq) so the emblem reads.
    const pieceGeom = new BufferGeometry();
    const R = sq * 0.42;
    const positions: number[] = [];
    const indices: number[] = [];
    const segs = 20;
    positions.push(0, 0, 0);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      positions.push(Math.cos(a) * R, 0, Math.sin(a) * R);
    }
    for (let i = 1; i <= segs; i++) {
      indices.push(0, i, i + 1);
    }
    pieceGeom.setAttribute("position", new Float32BufferAttribute(positions, 3));
    pieceGeom.setIndex(indices);
    pieceGeom.computeVertexNormals();

    const celluloidMat = new MeshStandardMaterial({
      color: CELLULOID,
      roughness: 0.55,
      metalness: 0.02,
      side: DoubleSide,
    });
    const inkMat = new MeshStandardMaterial({
      color: INK,
      roughness: 0.75,
      metalness: 0.0,
      side: DoubleSide,
    });
    const brassMat = new MeshStandardMaterial({
      color: BRASS,
      roughness: 0.35,
      metalness: 0.7,
    });

    // Build glyph shapes with ShapeGeometry from a canvas → not trivial.
    // Simpler: use a tiny 3D primitive for each piece TYPE that reads at
    // a distance (K = tall cross, Q = star, R = square tower, B = pointed,
    // N = angled, P = round bump). All rendered in either celluloid
    // (white pieces = light disc + ink emblem) or ink (black pieces =
    // ink disc + celluloid emblem inversion). This carries the Duchamp
    // "flat printed silhouette" feel without needing 3D chess models.
    for (const p of PIECES) {
      const g = new Group();
      // Base disc
      const base = new Mesh(pieceGeom, p.white ? celluloidMat : inkMat);
      base.position.y = 0.03;
      g.add(base);
      // Emblem
      const emblem = buildEmblem(p.glyph, R);
      const emblemMesh = new Mesh(emblem, p.white ? inkMat : celluloidMat);
      emblemMesh.position.y = 0.05;
      g.add(emblemMesh);
      // Pin head — small brass square at the disc center (readable from
      // above; kept subtle so it doesn't fight the emblem).
      const pinGeom = new BoxGeometry(0.06, 0.04, 0.06);
      const pin = new Mesh(pinGeom, brassMat);
      pin.position.y = 0.08;
      g.add(pin);

      g.position.set(
        boardOffsetX - boardSize / 2 + sq / 2 + p.file * sq,
        0.02,
        -boardSize / 2 + sq / 2 + p.rank * sq,
      );
      wallet.add(g);
    }

    // Right flap rack — a subtle inset panel with two rows of empty
    // piece "pockets" (small circles etched into the leather).
    const rackMat = new MeshStandardMaterial({ color: LEATHER_DEEP, roughness: 0.95 });
    const rack = new Mesh(new PlaneGeometry(3.4, 3.4), rackMat);
    rack.rotation.x = -Math.PI / 2;
    rack.position.set(w / 4, 0.001, 0);
    wallet.add(rack);

    // Pocket dots on the rack — hint at the missing pieces that
    // "belong" there but are on the board right now.
    const dotGeom = new BufferGeometry();
    const dotPos: number[] = [0, 0, 0];
    const dotIdx: number[] = [];
    const dotSegs = 10;
    const rr = 0.09;
    for (let i = 0; i <= dotSegs; i++) {
      const a = (i / dotSegs) * Math.PI * 2;
      dotPos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    }
    for (let i = 1; i <= dotSegs; i++) dotIdx.push(0, i, i + 1);
    dotGeom.setAttribute("position", new Float32BufferAttribute(dotPos, 3));
    dotGeom.setIndex(dotIdx);
    dotGeom.computeVertexNormals();
    const dotMat = new MeshStandardMaterial({ color: BRASS, roughness: 0.4, metalness: 0.6 });
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 8; col++) {
        const dot = new Mesh(dotGeom, dotMat);
        dot.rotation.x = -Math.PI / 2;
        const spacing = 0.36;
        dot.position.set(
          w / 4 - (spacing * 3.5) + col * spacing,
          0.02,
          -(spacing * 1.5) + row * spacing,
        );
        wallet.add(dot);
      }
    }

    // Interaction — drag to orbit within ±20°; release springs home.
    const target = new Vector2(0.15, -0.05); // idle tilt (radians)
    const current = new Vector2(target.x, target.y);
    const dragging = { active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };
    let idleT = 0;

    function onPointerDown(e: PointerEvent) {
      dragging.active = true;
      dragging.startX = e.clientX;
      dragging.startY = e.clientY;
      dragging.baseX = current.x;
      dragging.baseY = current.y;
      renderer.domElement.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragging.active) return;
      const dx = (e.clientX - dragging.startX) / width;
      const dy = (e.clientY - dragging.startY) / height;
      const max = Math.PI / 9; // 20°
      target.x = clamp(dragging.baseX + dy * 1.4, -max, max);
      target.y = clamp(dragging.baseY + dx * 1.4, -max, max);
    }
    function onPointerUp(e: PointerEvent) {
      dragging.active = false;
      // Reset target to idle tilt so it eases back.
      target.set(0.15, -0.05);
      renderer.domElement.releasePointerCapture(e.pointerId);
    }
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      const w2 = mount.clientWidth;
      const h2 = mount.clientHeight;
      if (w2 === 0 || h2 === 0) return;
      renderer.setSize(w2, h2, false);
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(mount);

    // Animate
    let raf = 0;
    let lastT = performance.now();
    function tick(now: number) {
      if (disposedRef.current) return;
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;
      idleT += dt;
      // Idle micro-sway if not dragging
      const idleX = dragging.active ? 0 : Math.sin(idleT * 0.4) * 0.02;
      const idleY = dragging.active ? 0 : Math.cos(idleT * 0.3) * 0.03;
      current.x += (target.x + idleX - current.x) * 0.08;
      current.y += (target.y + idleY - current.y) * 0.08;
      wallet.rotation.x = current.x;
      wallet.rotation.y = current.y;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.dispose();
      // Dispose all geometries + materials we allocated
      pieceGeom.dispose();
      dotGeom.dispose();
      leatherMat.dispose();
      leatherEdgeMat.dispose();
      honeyMat.dispose();
      coffeeMat.dispose();
      frameMat.dispose();
      celluloidMat.dispose();
      inkMat.dispose();
      brassMat.dispose();
      rackMat.dispose();
      dotMat.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// Emblem shapes for each piece — small flat 3D primitives that read
// as their piece type from a distance. Not literal Staunton — the
// Duchamp pieces themselves were custom silhouettes; these carry the
// same "printed on celluloid" flatness in 3D form.
function buildEmblem(type: Placement["glyph"], R: number): BufferGeometry {
  const s = R * 0.55; // emblem half-size
  switch (type) {
    case "K": {
      // Cross on a stem
      return unionRects([
        [-s * 0.15, -s * 0.8, s * 0.3, s * 1.6], // vertical
        [-s * 0.7, s * 0.15, s * 1.4, s * 0.3],  // horizontal
      ]);
    }
    case "Q": {
      // Five-point crown
      return polygon([
        new Vector3(0, 0, -s * 0.9),
        new Vector3(s * 0.35, 0, -s * 0.35),
        new Vector3(s * 0.9, 0, s * 0.3),
        new Vector3(s * 0.45, 0, s * 0.5),
        new Vector3(0, 0, s * 0.2),
        new Vector3(-s * 0.45, 0, s * 0.5),
        new Vector3(-s * 0.9, 0, s * 0.3),
        new Vector3(-s * 0.35, 0, -s * 0.35),
      ]);
    }
    case "R":
      // Battlement — square with two notches
      return unionRects([
        [-s * 0.75, -s * 0.75, s * 1.5, s * 1.5],
      ]);
    case "B":
      // Pointed miter
      return polygon([
        new Vector3(0, 0, -s * 0.9),
        new Vector3(s * 0.55, 0, s * 0.7),
        new Vector3(-s * 0.55, 0, s * 0.7),
      ]);
    case "N":
      // Horse arrow — angled parallelogram
      return polygon([
        new Vector3(-s * 0.4, 0, -s * 0.8),
        new Vector3(s * 0.8, 0, -s * 0.2),
        new Vector3(s * 0.4, 0, s * 0.8),
        new Vector3(-s * 0.8, 0, s * 0.2),
      ]);
    case "P":
    default:
      // Simple disc
      return polygon(
        Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return new Vector3(Math.cos(a) * s * 0.55, 0, Math.sin(a) * s * 0.55);
        }),
      );
  }
}

function unionRects(rects: Array<[number, number, number, number]>): BufferGeometry {
  // Build a single geometry combining rectangles as separate quads.
  const positions: number[] = [];
  const indices: number[] = [];
  let idx = 0;
  for (const [x, z, wRect, hRect] of rects) {
    positions.push(x, 0, z, x + wRect, 0, z, x + wRect, 0, z + hRect, x, 0, z + hRect);
    indices.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
    idx += 4;
  }
  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function polygon(points: Vector3[]): BufferGeometry {
  const geom = new ShapeGeometry(shapeFromPoints(points));
  geom.rotateX(-Math.PI / 2);
  return geom;
}

function shapeFromPoints(points: Vector3[]) {
  const s = new Shape();
  s.moveTo(points[0].x, points[0].z);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i].x, points[i].z);
  s.closePath();
  return s;
}
