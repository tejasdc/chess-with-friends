// 3D landing scene — an opened Duchamp Pocket Chess Set (leather
// bifold wallet with hand-painted board on the left flap and cream
// celluloid piece tokens on the right flap). Grabbable: pointer drag
// orbits ±20°; releases back to a slow idle sway. All geometry and
// textures are generated in code — no external assets, no image
// downloads. Lazy-loaded from AuthScreen via React.lazy so unauth
// first paint stays lean.
//
// Materials pass (round 8): procedural canvas noise gives the leather
// visible grain and patina; brass is properly metallic with strong
// specular; white celluloid uses MeshPhysicalMaterial for slight
// translucency; piece emblems are extruded relief (0.02 depth) so they
// read as printed-on-celluloid at any angle. Warmer three-point
// lighting picks up the surface variance.

import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  Shape,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

// Palette — same hue family as the CSS Duchamp tokens, tuned brighter
// for physically-based lighting (dark base colors absorb light).
const LEATHER_DEEP = new Color("#221a11");
const LEATHER = new Color("#4a3220");
const LEATHER_LIT = new Color("#6b4a2c");
const HONEY = new Color("#e7c48c");
const COFFEE = new Color("#4a3320");
const CELLULOID = new Color("#f5ecd0");
const INK = new Color("#17110a");
const BRASS = new Color("#d3a45a");

// A mid-game moment that reads well from the camera — pieces spread
// across the board, no clumping. Positions are (file, rank) 0-7.
type Placement = { file: number; rank: number; glyph: "K" | "Q" | "R" | "B" | "N" | "P"; white: boolean };
const PIECES: Placement[] = [
  { file: 4, rank: 0, glyph: "K", white: true },
  { file: 3, rank: 0, glyph: "Q", white: true },
  { file: 2, rank: 3, glyph: "N", white: true },
  { file: 4, rank: 3, glyph: "P", white: true },
  { file: 1, rank: 2, glyph: "B", white: true },
  { file: 6, rank: 1, glyph: "R", white: true },
  { file: 2, rank: 5, glyph: "N", white: false },
  { file: 4, rank: 4, glyph: "P", white: false },
  { file: 3, rank: 7, glyph: "Q", white: false },
  { file: 4, rank: 7, glyph: "K", white: false },
  { file: 6, rank: 5, glyph: "B", white: false },
  { file: 1, rank: 6, glyph: "R", white: false },
];

// Simple degrade check — hide the 3D scene if the device is unlikely
// to render it well. Falls back to a plain solid-color panel that the
// AuthScreen wraps.
function shouldDegrade(): boolean {
  if (typeof window === "undefined") return true;
  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number };
  if (nav.deviceMemory && nav.deviceMemory < 2) return true;
  if (nav.hardwareConcurrency && nav.hardwareConcurrency < 2) return true;
  // No obvious WebGL support — degrade.
  try {
    const c = document.createElement("canvas");
    if (!c.getContext("webgl2") && !c.getContext("webgl")) return true;
  } catch {
    return true;
  }
  return false;
}

export default function WalletScene() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const disposedRef = useRef(false);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    if (shouldDegrade()) {
      setDegraded(true);
      return;
    }

    disposedRef.current = false;

    const width = mount.clientWidth;
    const height = mount.clientHeight;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      setDegraded(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(LEATHER_DEEP, 1);
    mount.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.background = LEATHER_DEEP;

    const camera = new PerspectiveCamera(34, width / height, 0.1, 100);
    camera.position.set(0, 5.6, 7.6);
    camera.lookAt(0, 0, 0.2);

    // ---------- lighting ----------
    // Warm three-point: soft ambient, hot key from upper-right, brass
    // rim from behind-left, cool fill from viewer to keep faces lit.
    const ambient = new AmbientLight(0xffe6ba, 0.55);
    scene.add(ambient);
    const key = new DirectionalLight(0xffe4b0, 2.2);
    key.position.set(4, 8, 5);
    scene.add(key);
    const rim = new DirectionalLight(0xd18a3a, 0.9);
    rim.position.set(-6, 3, -4);
    scene.add(rim);
    const fill = new DirectionalLight(0xffefc9, 0.5);
    fill.position.set(-1, 4, 8);
    scene.add(fill);

    // ---------- procedural textures ----------
    const leatherTex = makeLeatherTexture();
    const boardTex = makeBoardTexture();
    const rackTex = makeRackTexture();

    // ---------- materials ----------
    const leatherMat = new MeshStandardMaterial({
      color: LEATHER,
      map: leatherTex,
      roughness: 0.85,
      metalness: 0.02,
    });
    const boardMat = new MeshStandardMaterial({
      color: 0xffffff,
      map: boardTex,
      roughness: 0.78,
      metalness: 0.0,
    });
    const rackMat = new MeshStandardMaterial({
      color: 0xffffff,
      map: rackTex,
      roughness: 0.9,
      metalness: 0.0,
    });
    const celluloidWhiteMat = new MeshPhysicalMaterial({
      color: CELLULOID,
      roughness: 0.35,
      metalness: 0.02,
      transmission: 0.12,          // slight see-through — celluloid is not opaque
      thickness: 0.15,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
      ior: 1.45,
      side: DoubleSide,
    });
    const celluloidBlackMat = new MeshStandardMaterial({
      color: INK,
      roughness: 0.5,
      metalness: 0.0,
      side: DoubleSide,
    });
    const inkOnWhite = new MeshStandardMaterial({
      color: INK,
      roughness: 0.75,
      metalness: 0.0,
      side: DoubleSide,
    });
    const inkOnBlack = new MeshStandardMaterial({
      color: CELLULOID,
      roughness: 0.55,
      metalness: 0.05,
      side: DoubleSide,
    });
    const brassMat = new MeshStandardMaterial({
      color: BRASS,
      roughness: 0.22,
      metalness: 0.85,
    });

    // ---------- geometry ----------
    // Bifold wallet — compressed 8×5 (aspect close to the real object).
    const w = 8;
    const d = 5;
    const covT = 0.24;
    const wallet = new Group();
    scene.add(wallet);

    // Left flap (board) + right flap (rack)
    const leftCover = new Mesh(new PlaneGeometry(w / 2, d), leatherMat);
    leftCover.rotation.x = -Math.PI / 2;
    leftCover.position.set(-w / 4, -covT / 2, 0);
    wallet.add(leftCover);
    const rightCover = new Mesh(new PlaneGeometry(w / 2, d), leatherMat);
    rightCover.rotation.x = -Math.PI / 2;
    rightCover.position.set(w / 4, -covT / 2, 0);
    wallet.add(rightCover);

    // A thin recessed spine at the fold
    const spine = new Mesh(new PlaneGeometry(0.12, d), new MeshStandardMaterial({ color: LEATHER_DEEP, roughness: 0.95 }));
    spine.rotation.x = -Math.PI / 2;
    spine.position.set(0, -covT / 2 + 0.001, 0);
    wallet.add(spine);

    // Board — one textured plane instead of 64 individual meshes.
    // Includes painted squares AND the darker border in the texture.
    const boardSize = 3.6;
    const boardOffsetX = -w / 4;
    const board = new Mesh(new PlaneGeometry(boardSize, boardSize), boardMat);
    board.rotation.x = -Math.PI / 2;
    board.position.set(boardOffsetX, -0.001, 0);
    wallet.add(board);

    // Right flap rack — a single textured plane with piece-pocket art
    const rack = new Mesh(new PlaneGeometry(boardSize, boardSize), rackMat);
    rack.rotation.x = -Math.PI / 2;
    rack.position.set(w / 4, -0.001, 0);
    wallet.add(rack);

    // ---------- pieces ----------
    // Each piece = celluloid disc (thin extrusion) + ink emblem in
    // relief on top + brass pin at the disc's center.
    const sq = boardSize / 8;
    const R = sq * 0.42;

    // Disc — small extruded circle, 0.05 thick
    const discShape = new Shape();
    const segs = 24;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      if (i === 0) discShape.moveTo(x, z);
      else discShape.lineTo(x, z);
    }
    const discGeom = new ExtrudeGeometry(discShape, { depth: 0.05, bevelEnabled: true, bevelSegments: 2, bevelThickness: 0.005, bevelSize: 0.005 });
    discGeom.rotateX(-Math.PI / 2);

    // Pin — tiny brass cylinder-ish (use box for simpler geo)
    const pinGeom = new ExtrudeGeometry(
      (() => {
        const s = new Shape();
        const r = 0.045;
        const n = 12;
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          if (i === 0) s.moveTo(x, z);
          else s.lineTo(x, z);
        }
        return s;
      })(),
      { depth: 0.04, bevelEnabled: true, bevelSegments: 3, bevelThickness: 0.008, bevelSize: 0.008 },
    );
    pinGeom.rotateX(-Math.PI / 2);

    for (const p of PIECES) {
      const g = new Group();
      const disc = new Mesh(discGeom, p.white ? celluloidWhiteMat : celluloidBlackMat);
      disc.position.y = 0.005;
      g.add(disc);

      const emblemGeom = buildEmblem(p.glyph, R);
      const emblemMesh = new Mesh(emblemGeom, p.white ? inkOnWhite : inkOnBlack);
      emblemMesh.position.y = 0.055;
      g.add(emblemMesh);

      const pin = new Mesh(pinGeom, brassMat);
      pin.position.y = 0.1;
      g.add(pin);

      g.position.set(
        boardOffsetX - boardSize / 2 + sq / 2 + p.file * sq,
        0.02,
        -boardSize / 2 + sq / 2 + p.rank * sq,
      );
      wallet.add(g);
    }

    // ---------- interaction ----------
    const target = new Vector2(0.18, -0.06);
    const current = new Vector2(target.x, target.y);
    const dragging = { active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };
    let idleT = 0;

    function onPointerDown(e: PointerEvent) {
      dragging.active = true;
      dragging.startX = e.clientX;
      dragging.startY = e.clientY;
      dragging.baseX = current.x;
      dragging.baseY = current.y;
      try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* older iOS */ }
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
      target.set(0.18, -0.06);
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* older iOS */ }
    }
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);

    const resizeObserver = new ResizeObserver(() => {
      const w2 = mount.clientWidth;
      const h2 = mount.clientHeight;
      if (w2 === 0 || h2 === 0) return;
      renderer.setSize(w2, h2, false);
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(mount);

    let raf = 0;
    let lastT = performance.now();
    function tick(now: number) {
      if (disposedRef.current) return;
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;
      idleT += dt;
      const idleX = dragging.active ? 0 : Math.sin(idleT * 0.35) * 0.02;
      const idleY = dragging.active ? 0 : Math.cos(idleT * 0.28) * 0.03;
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
      leatherTex.dispose();
      boardTex.dispose();
      rackTex.dispose();
      discGeom.dispose();
      pinGeom.dispose();
      leatherMat.dispose();
      boardMat.dispose();
      rackMat.dispose();
      celluloidWhiteMat.dispose();
      celluloidBlackMat.dispose();
      inkOnWhite.dispose();
      inkOnBlack.dispose();
      brassMat.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  if (degraded) {
    // Static fallback for low-memory devices or missing WebGL — a
    // solid-color panel styled by CSS (.auth-scene inherits the paper
    // ground). Nothing to see is better than a stalled scene.
    return <div ref={mountRef} className="auth-scene-degraded" aria-hidden="true" />;
  }
  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// ---------- procedural texture generation ----------
// Draw once at mount, reuse forever — canvas textures are cheap and
// avoid the 137KB three.js chunk having to ship image bytes.

function makeLeatherTexture(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Base — warm dark brown
  ctx.fillStyle = "#4a3220";
  ctx.fillRect(0, 0, size, size);
  // Broad tonal variation via low-freq noise
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 60 + Math.random() * 140;
    const alpha = 0.02 + Math.random() * 0.05;
    const dark = Math.random() < 0.5;
    ctx.fillStyle = dark ? `rgba(20, 12, 6, ${alpha})` : `rgba(122, 88, 54, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fine grain — thousands of tiny specks
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const jitter = (Math.random() - 0.5) * 26;
    data[i] = clampByte(data[i] + jitter);
    data[i + 1] = clampByte(data[i + 1] + jitter * 0.7);
    data[i + 2] = clampByte(data[i + 2] + jitter * 0.4);
  }
  ctx.putImageData(img, 0, 0);
  // Faint parallel scratches — the aged-leather grain direction
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = "#1a0f06";
  for (let i = 0; i < 220; i++) {
    const y = Math.random() * size;
    const x1 = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x1 + 20 + Math.random() * 80, y + (Math.random() - 0.5) * 3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeBoardTexture(): CanvasTexture {
  // Hand-painted-look 8×8 board on tan ground. Each square gets its
  // own tiny brush variance so the render is not flat vector.
  const size = 512;
  const inset = 24;
  const inner = size - inset * 2;
  const sq = inner / 8;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Board frame — darker leather rim
  ctx.fillStyle = "#3a2818";
  ctx.fillRect(0, 0, size, size);

  // Painted squares with per-square micro noise
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      const dark = (f + r) % 2 === 0;
      const base = dark ? "#4a3320" : "#e7c48c";
      ctx.fillStyle = base;
      ctx.fillRect(inset + f * sq, inset + r * sq, sq, sq);
      // Brushwork — small elliptical highlights + shadows
      const strokes = 8;
      for (let i = 0; i < strokes; i++) {
        const x = inset + f * sq + Math.random() * sq;
        const y = inset + r * sq + Math.random() * sq;
        const rad = 4 + Math.random() * 8;
        const alpha = 0.03 + Math.random() * 0.05;
        const light = Math.random() < 0.5;
        ctx.fillStyle = light
          ? (dark ? `rgba(150, 110, 70, ${alpha})` : `rgba(255, 240, 200, ${alpha})`)
          : (dark ? `rgba(20, 12, 6, ${alpha})` : `rgba(120, 80, 40, ${alpha})`);
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Faint hand-drawn hairline between squares — the ruler mark the
  // artist would have drawn.
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "#1a0f06";
  ctx.lineWidth = 0.6;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(inset + i * sq, inset);
    ctx.lineTo(inset + i * sq, inset + inner);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(inset, inset + i * sq);
    ctx.lineTo(inset + inner, inset + i * sq);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function makeRackTexture(): CanvasTexture {
  // Right flap — dark leather with two rows of piece pockets punched
  // out (subtle recessed circles). Echoes the physical piece storage.
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#3a2818";
  ctx.fillRect(0, 0, size, size);
  // Same broad tonal noise as leather for continuity
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 40 + Math.random() * 100;
    const alpha = 0.02 + Math.random() * 0.04;
    ctx.fillStyle = `rgba(120, 88, 54, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pocket dots
  const rows = 4;
  const cols = 8;
  const marginX = 60;
  const marginY = 100;
  const spX = (size - marginX * 2) / (cols - 1);
  const spY = (size - marginY * 2) / (rows - 1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = marginX + c * spX;
      const cy = marginY + r * spY;
      // Recessed dark disc
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 22);
      grad.addColorStop(0, "rgba(0, 0, 0, 0.55)");
      grad.addColorStop(0.7, "rgba(0, 0, 0, 0.25)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.fill();
      // Brass pin head at the center
      const pinGrad = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 5);
      pinGrad.addColorStop(0, "#f2c775");
      pinGrad.addColorStop(0.7, "#c99a4a");
      pinGrad.addColorStop(1, "#7a5a2a");
      ctx.fillStyle = pinGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

// ---------- piece emblems ----------
// Extruded 3D relief primitives, ~0.02 tall so they read as ink
// printed on celluloid with a slight raise. Not literal Staunton —
// Duchamp's pieces were also abstract silhouettes.

function buildEmblem(type: Placement["glyph"], R: number): BufferGeometry {
  const s = R * 0.6;
  let shape: Shape;
  switch (type) {
    case "K": {
      // Cross
      shape = new Shape();
      const t = s * 0.28;
      shape.moveTo(-t, -s);
      shape.lineTo(t, -s);
      shape.lineTo(t, -t);
      shape.lineTo(s, -t);
      shape.lineTo(s, t);
      shape.lineTo(t, t);
      shape.lineTo(t, s);
      shape.lineTo(-t, s);
      shape.lineTo(-t, t);
      shape.lineTo(-s, t);
      shape.lineTo(-s, -t);
      shape.lineTo(-t, -t);
      shape.closePath();
      break;
    }
    case "Q": {
      // Five-point crown
      shape = new Shape();
      const points = [
        [0, -s * 0.95],
        [s * 0.32, -s * 0.32],
        [s * 0.95, -s * 0.15],
        [s * 0.5, s * 0.3],
        [s * 0.6, s * 0.85],
        [0, s * 0.5],
        [-s * 0.6, s * 0.85],
        [-s * 0.5, s * 0.3],
        [-s * 0.95, -s * 0.15],
        [-s * 0.32, -s * 0.32],
      ] as Array<[number, number]>;
      shape.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
      shape.closePath();
      break;
    }
    case "R": {
      // Battlement — square with three notches on top
      shape = new Shape();
      shape.moveTo(-s * 0.8, s * 0.8);
      shape.lineTo(-s * 0.8, -s * 0.3);
      shape.lineTo(-s * 0.8, -s * 0.6);
      shape.lineTo(-s * 0.45, -s * 0.6);
      shape.lineTo(-s * 0.45, -s * 0.85);
      shape.lineTo(-s * 0.15, -s * 0.85);
      shape.lineTo(-s * 0.15, -s * 0.6);
      shape.lineTo(s * 0.15, -s * 0.6);
      shape.lineTo(s * 0.15, -s * 0.85);
      shape.lineTo(s * 0.45, -s * 0.85);
      shape.lineTo(s * 0.45, -s * 0.6);
      shape.lineTo(s * 0.8, -s * 0.6);
      shape.lineTo(s * 0.8, s * 0.8);
      shape.closePath();
      break;
    }
    case "B": {
      // Pointed miter
      shape = new Shape();
      shape.moveTo(0, -s * 0.95);
      shape.lineTo(s * 0.6, s * 0.4);
      shape.lineTo(s * 0.4, s * 0.75);
      shape.lineTo(-s * 0.4, s * 0.75);
      shape.lineTo(-s * 0.6, s * 0.4);
      shape.closePath();
      break;
    }
    case "N": {
      // Knight — angled parallelogram with an ear
      shape = new Shape();
      shape.moveTo(-s * 0.7, s * 0.7);
      shape.lineTo(-s * 0.85, -s * 0.15);
      shape.lineTo(-s * 0.3, -s * 0.75);
      shape.lineTo(s * 0.55, -s * 0.55);
      shape.lineTo(s * 0.85, s * 0.1);
      shape.lineTo(s * 0.35, s * 0.7);
      shape.closePath();
      break;
    }
    case "P":
    default: {
      // Small filled disc for pawn
      shape = new Shape();
      const n = 20;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = Math.cos(a) * s * 0.6;
        const z = Math.sin(a) * s * 0.6;
        if (i === 0) shape.moveTo(x, z);
        else shape.lineTo(x, z);
      }
      shape.closePath();
      break;
    }
  }
  const g = new ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: true, bevelSegments: 2, bevelThickness: 0.004, bevelSize: 0.004 });
  g.rotateX(-Math.PI / 2);
  return g;
}

// Kept only to appease strict-unused imports if a future refactor drops one.
const _keepAlive = { Float32BufferAttribute, Vector3 };
void _keepAlive;
