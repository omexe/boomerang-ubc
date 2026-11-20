// The boomerang's flight: one real 3D object on one path. Thrown nearly upright, it curves away
// and either lands on the target (the campaign is met) or comes all the way back, laying flat as
// it slows (it missed, and the pledge returns). This is the mockup's "security" style alone:
// engraved line shading from a shader, with a guilloche trace drawn beside it on the page. The
// "postal" and "riso" styles the mockup also carried are gone, with everything only they used.
//
// three.js is imported here and nowhere else, so a dynamic import of this module lands it in its
// own chunk and never blocks first paint. mountFlight returns a disposer that stops the loop,
// disconnects its observers and listeners, and releases every GPU resource it made.
import * as THREE from "three";

const VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vObj;
  void main() {
    vN = normalize(normalMatrix * normal);
    vObj = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
// Engraved shading: the darker a facet faces, the denser the ink lines across the object.
const FRAG = /* glsl */ `
  uniform vec3 ink; uniform vec3 light; uniform float cell;
  varying vec3 vN; varying vec3 vObj;
  void main() {
    float l = clamp(dot(normalize(vN), normalize(light)) * 0.5 + 0.5, 0.0, 1.0);
    float dark = 1.0 - l;
    float v = fract((vObj.x * 0.9 + vObj.y * 0.4 + vObj.z * 0.6) * cell);
    float on = step(v, dark * 0.85 + 0.16);
    if (on < 0.5) discard;
    gl_FragColor = vec4(ink, 1.0);
  }`;

function boomerangGeometry(k = 0.62): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(-1.7, -0.5);
  s.quadraticCurveTo(-0.95, 0.5, 0, 0.48);
  s.quadraticCurveTo(0.95, 0.5, 1.7, -0.5);
  s.quadraticCurveTo(1.82, -0.78, 1.52, -0.86);
  s.quadraticCurveTo(0.78, -0.02, 0, 0.0);
  s.quadraticCurveTo(-0.78, -0.02, -1.52, -0.86);
  s.quadraticCurveTo(-1.82, -0.78, -1.7, -0.5);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 5, curveSegments: 24 });
  g.center();
  g.scale(k, k, k);
  return g;
}

// Where the boomerang is at t in [0, 1] of a full out-and-back loop.
function loopPoint(t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = t * Math.PI * 2;
  return out.set(1.75 * Math.sin(a), 0.3 + 1.25 * Math.sin(Math.PI * t), -2.0 * (1 - Math.cos(a)));
}
const TARGET = loopPoint(0.5).clone().setY(0.05);

type Ending = "met" | "missed";

// The path for one ending, sampled into N points.
function samplePath(ending: Ending, n = 220): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    if (ending === "missed") pts.push(loopPoint(u));
    else if (u < 0.82) pts.push(loopPoint((u / 0.82) * 0.5));
    else { const k = (u - 0.82) / 0.18; const p = loopPoint(0.5); p.y = THREE.MathUtils.lerp(p.y, TARGET.y + 0.08, k * k); pts.push(p); }
  }
  return pts;
}

export interface FlightColors {
  ink: string;
  trail: string;
  trailMet?: string;
  mark: string;
}

export interface FlightOptions {
  style?: "security";
  scale?: number;
  parallax?: boolean;
  sequence?: [string, number][];
  colors: FlightColors;
  anchors?: { goal?: HTMLElement | null; home?: HTMLElement | null };
  onPhase?: (phase: string) => void;
}

export function mountFlight(canvas: HTMLCanvasElement, opts: FlightOptions): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false });
  const dpr = Math.min(devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
  camera.position.set(0.15, 2.0, 5.1);
  camera.lookAt(0, 0.6, -1.8);

  const scene = new THREE.Scene();
  const geo = boomerangGeometry(opts.scale);
  const body = new THREE.Group();
  scene.add(body);

  const bodyMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { ink: { value: new THREE.Color(opts.colors.ink) }, light: { value: new THREE.Vector3(-0.4, 1, 0.7) }, cell: { value: 26.0 } },
  });
  body.add(new THREE.Mesh(geo, bodyMat));

  // Thrower and target marks on the ground.
  const ringMat = new THREE.MeshBasicMaterial({ color: opts.colors.mark, transparent: true, opacity: 0.9 });
  const ringGeos: THREE.RingGeometry[] = [];
  const ring = (r: number) => { const g = new THREE.RingGeometry(r, r + 0.03, 64); ringGeos.push(g); const m = new THREE.Mesh(g, ringMat); m.rotation.x = -Math.PI / 2; return m; };
  const home = ring(0.28); home.position.set(0, 0.0, 0); scene.add(home);
  const goal = new THREE.Group(); goal.add(ring(0.34), ring(0.2)); goal.position.copy(TARGET).setY(0.0); scene.add(goal);

  // The trail, revealed as it flies.
  const paths: Record<Ending, THREE.Vector3[]> = { met: samplePath("met"), missed: samplePath("missed") };
  const trails = {} as Record<Ending, THREE.Line>;
  for (const k of ["met", "missed"] as const) {
    const g = new THREE.BufferGeometry().setFromPoints(paths[k]);
    const mat = new THREE.LineBasicMaterial({ color: k === "met" ? opts.colors.trailMet ?? opts.colors.trail : opts.colors.trail, transparent: true });
    const line = new THREE.Line(g, mat);
    line.visible = false;
    scene.add(line);
    trails[k] = line;
  }

  const qUp = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2 - 0.15, 0.12));
  const qFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const qSpin = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const ease = (x: number) => 1 - Math.pow(1 - x, 3);

  // Speed along the path: a met flight eases out and in to its landing; a missed one starts
  // fast and slows as it comes home, the way a real one hovers before it is caught.
  const travel = (ending: Ending, u: number) => ending === "met" ? 0.5 - 0.5 * Math.cos(Math.PI * u) : 1 - Math.pow(1 - u, 1.8);
  function pose(ending: Ending, u0: number, fade = 1) {
    const u = travel(ending, u0);
    const pts = paths[ending];
    const i = Math.min(pts.length - 1, Math.floor(u * (pts.length - 1)));
    body.position.copy(pts[i]);
    const lay = ending === "missed" ? ease(u) : ease(Math.min(1, u * 1.15));
    const spins = ending === "missed" ? 7 : 4.5;
    // Spin slows near the end, as a real one does when it hovers down.
    const spinU = ending === "missed" ? 1 - Math.pow(1 - u, 1.6) : 1 - Math.pow(1 - u, 2.2);
    qSpin.setFromAxisAngle(zAxis, spinU * spins * Math.PI * 2);
    body.quaternion.slerpQuaternions(qUp, qFlat, lay).multiply(qSpin);
    trails[ending].visible = true;
    trails[ending].geometry.setDrawRange(0, i + 1);
    (trails[ending].material as THREE.LineBasicMaterial).opacity = fade;
    trails[ending === "met" ? "missed" : "met"].visible = false;
  }

  let w = 0, h = 0;
  // The camera leans a little toward the pointer, so the scene answers the hand.
  const base = camera.position.clone(), home0 = camera.position.clone(), look = new THREE.Vector3(0, 0.6, -1.8);
  let px = 0, py = 0, cx = 0, cy = 0;
  const onPointer = (e: PointerEvent) => { px = (e.clientX / innerWidth) * 2 - 1; py = (e.clientY / innerHeight) * 2 - 1; };
  if (opts.parallax) addEventListener("pointermove", onPointer, { passive: true });
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width === w && r.height === h) return;
    w = r.width; h = r.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    // On a narrow canvas, step back along the line of sight so the whole loop stays in frame.
    const back = Math.max(1, 1.08 / camera.aspect) * (w < 520 ? 1.32 : 1);
    base.copy(look).addScaledVector(home0.clone().sub(look), back);
    camera.position.copy(base); camera.lookAt(look);
  }
  function draw() {
    resize();
    if (opts.parallax) {
      cx += (px - cx) * 0.04; cy += (py - cy) * 0.04;
      camera.position.set(base.x + cx * 0.45, base.y - cy * 0.22, base.z);
      camera.lookAt(look);
    }
    renderer.clear();
    renderer.render(scene, camera);
    if (opts.anchors) {
      for (const [k, el] of Object.entries(opts.anchors)) {
        if (!el) continue;
        const v = (k === "goal" ? TARGET.clone().setY(0) : new THREE.Vector3(0, 0, 0)).project(camera);
        el.style.left = ((v.x + 1) / 2) * w + "px";
        el.style.top = ((1 - v.y) / 2) * h + "px";
      }
    }
  }

  // The show: met, a breath, missed, a breath, around again.
  const SEQ: [string, number][] = opts.sequence ?? [["met", 3.4], ["hold-met", 1.4], ["missed", 5.2], ["hold-missed", 1.6]];
  const total = SEQ.reduce((s, x) => s + x[1], 0);
  let last = "";
  let running = !reduce;
  let onScreen = true; // assumed until the observer says otherwise, so the flight never waits on the observer's first report
  let rafId = 0;
  let io: IntersectionObserver | null = null;

  // Redraw whenever the box changes (a resize, or fonts arriving and reflowing the page).
  const ro = new ResizeObserver(() => { w = 0; draw(); });
  ro.observe(canvas);
  // Pausing off screen is the observer below; pausing when the tab is hidden is this.
  const onVisibility = () => sync();
  document.addEventListener("visibilitychange", onVisibility);

  function request() { if (!rafId) rafId = requestAnimationFrame(tick); }
  function sync() {
    running = !reduce && onScreen && !document.hidden;
    if (running) request();
  }
  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    ro.disconnect();
    io?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    if (opts.parallax) removeEventListener("pointermove", onPointer);
    geo.dispose();
    bodyMat.dispose();
    ringMat.dispose();
    for (const g of ringGeos) g.dispose();
    for (const k of ["met", "missed"] as const) { trails[k].geometry.dispose(); (trails[k].material as THREE.Material).dispose(); }
    renderer.dispose();
    renderer.forceContextLoss(); // dispose alone keeps the context until the canvas is collected
  }

  if (reduce) { pose("missed", 0.62); draw(); opts.onPhase?.("missed"); return dispose; }

  const start = performance.now();
  io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }, { threshold: 0.05 });
  io.observe(canvas);
  sync();
  function tick(now: number) {
    rafId = 0;
    if (!running) return;
    let s = ((now - start) / 1000) % total;
    let phase = SEQ[0][0], u = 0;
    for (const [name, d] of SEQ) { if (s < d) { phase = name; u = s / d; break; } s -= d; }
    const ending: Ending = phase.endsWith("met") ? "met" : "missed";
    const hold = phase.startsWith("hold");
    pose(ending, hold ? 1 : u, hold ? 1 - Math.max(0, (u - 0.45) / 0.55) : 1);
    if (ending !== last) { last = ending; opts.onPhase?.(ending); }
    draw();
    request();
  }
  return dispose;
}
