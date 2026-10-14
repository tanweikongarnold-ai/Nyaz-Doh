// 3D pitch built with three.js. Blocky street players on a caged pitch under floodlights.
//
// The server only sends where everyone ended up plus a list of events for the turn.
// Events carry animation hints (ball `path`, new `holder`, tackle `slide`, `teleport`),
// which this file turns into a short replay: slides, passes, shots, keeper dives, goals.
//
// Same interface as the 2D pitch: update({ match, youSlot, targets, markers, playback }).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const CELL = 5; // metres per pitch column
const LANE = 10; // metres per lane
const BALL_R = 0.5;
const TEAM = { home: 0x3b82f6, away: 0xef4444 };
const TEAM_DARK = { home: 0x1e3a8a, away: 0x7f1d1d };
const KEEPER = { home: { shirt: 0x84cc16, shorts: 0x1a2e05 }, away: { shirt: 0xf59e0b, shorts: 0x451a03 } };

// Text painted on the wall and boards. The standalone web build sets its own name.
const BRAND = (globalThis.GAME_BRAND || 'ILLEGAL SOCCER').toUpperCase();

const wx = (x) => (x - 6) * CELL;
const wz = (y) => (y - 1) * LANE;
const toV = (p, h = 0) => new THREE.Vector3(wx(p.x), h, wz(p.y));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (t) => clamp(t, 0, 1);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const hump = (u) => 4 * u * (1 - u);
const angleLerp = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

const LOOKS = {
  blaze: { number: 9, skin: '#f1c27d', hair: 0xff6a00, style: 'spikes', scale: 1.0, face: 'grin' },
  nova: { number: 10, skin: '#e0ac69', hair: 0xc026d3, style: 'band', scale: 0.95, face: 'smile' },
  brutus: { number: 4, skin: '#8d5524', hair: 0x111111, style: 'flat', scale: 1.14, face: 'angry' },
  viper: { number: 11, skin: '#c68642', hair: 0x22c55e, style: 'mohawk', scale: 0.98, face: 'smirk' },
  ghost: { number: 8, skin: '#ffdbac', hair: 0xe5e7eb, style: 'hood', scale: 1.0, face: 'mask' },
  razor: { number: 5, skin: '#a16e4b', hair: 0x111827, style: 'bandana', scale: 1.08, face: 'scar' },
  keeper: { number: 1, skin: '#d4a373', hair: 0x27272a, style: 'cap', scale: 1.02, face: 'smile' },
};

export function webglAvailable() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Textures (all drawn on canvases, so there are no image files to load)

function canvasTex(w, h, draw, { repeat, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

function pitchTexture() {
  const PW = 70;
  const PH = 40;
  return canvasTex(2048, Math.round((2048 * PH) / PW), (g, w, h) => {
    const s = w / PW;
    const X = (m) => (m + PW / 2) * s;
    const Z = (m) => (m + PH / 2) * s;
    g.fillStyle = '#134d29';
    g.fillRect(0, 0, w, h);
    for (let i = -7; i <= 7; i++) {
      g.fillStyle = Math.abs(i) % 2 ? '#1b7a3e' : '#176c37';
      g.fillRect(X(i * CELL - CELL / 2), Z(-17), CELL * s, 34 * s);
    }
    // Turf grain
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 0.16 * s;
    g.strokeRect(X(-30), Z(-15), 60 * s, 30 * s);
    g.beginPath();
    g.moveTo(X(0), Z(-15));
    g.lineTo(X(0), Z(15));
    g.stroke();
    g.beginPath();
    g.arc(X(0), Z(0), 6 * s, 0, Math.PI * 2);
    g.stroke();
    for (const side of [-1, 1]) {
      const gx = side * 30;
      g.strokeRect(Math.min(X(gx), X(gx - side * 11.5)), Z(-10.5), 11.5 * s, 21 * s);
      g.strokeRect(Math.min(X(gx), X(gx - side * 4.5)), Z(-6), 4.5 * s, 12 * s);
      g.beginPath();
      g.arc(X(gx - side * 8), Z(0), 0.14 * s, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fill();
      for (const zs of [-1, 1]) {
        g.beginPath();
        g.arc(X(gx), Z(zs * 15), 1 * s, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.beginPath();
    g.arc(X(0), Z(0), 0.16 * s, 0, Math.PI * 2);
    g.fill();
    // Faint lane guides: the game thinks in top / middle / bottom lanes.
    g.setLineDash([1.2 * s, 1.2 * s]);
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 0.1 * s;
    for (const z of [-5, 5]) {
      g.beginPath();
      g.moveTo(X(-30), Z(z));
      g.lineTo(X(30), Z(z));
      g.stroke();
    }
  });
}

const asphaltTexture = () => canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#1b1e25';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2500; i++) {
    const v = 20 + Math.random() * 30;
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
  }
}, { repeat: [60, 60] });

const chainTexture = () => canvasTex(64, 64, (g, w) => {
  g.clearRect(0, 0, w, w);
  g.strokeStyle = 'rgba(190,200,215,0.95)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, w / 2); g.lineTo(w / 2, 0); g.lineTo(w, w / 2); g.lineTo(w / 2, w); g.closePath();
  g.stroke();
});

const netTexture = () => canvasTex(64, 64, (g, w) => {
  g.clearRect(0, 0, w, w);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, w, w);
});

function windowTexture() {
  return canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#0b0f1c';
    g.fillRect(0, 0, w, h);
    for (let y = 8; y < h - 8; y += 18) {
      for (let x = 8; x < w - 8; x += 16) {
        const r = Math.random();
        g.fillStyle = r < 0.22 ? '#ffd27a' : r < 0.3 ? '#9ad7ff' : '#141a2c';
        g.fillRect(x, y, 9, 11);
      }
    }
  });
}

function wallTexture() {
  return canvasTex(2048, 160, (g, w, h) => {
    g.fillStyle = '#3a2f33';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    for (let y = 0; y < h; y += 20) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      for (let x = (y / 20) % 2 ? 0 : 30; x < w; x += 60) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 20); g.stroke();
      }
    }
    const spray = (text, x, size, fill, stroke, rot) => {
      g.save();
      g.translate(x, h / 2);
      g.rotate(rot);
      g.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = size / 9;
      g.strokeStyle = stroke;
      g.strokeText(text, 0, 0);
      g.fillStyle = fill;
      g.fillText(text, 0, 0);
      g.restore();
    };
    spray(BRAND, w * 0.5, 104, '#facc15', '#111', -0.02);
    spray('NO REFS', w * 0.16, 70, '#f472b6', '#111', 0.05);
    spray('NO RULES', w * 0.84, 70, '#38bdf8', '#111', -0.04);
    spray('3v3', w * 0.03, 60, '#4ade80', '#111', 0.1);
    spray('GG', w * 0.97, 60, '#fb923c', '#111', -0.1);
  });
}

function boardTexture() {
  return canvasTex(2048, 64, (g, w, h) => {
    const ads = [[BRAND, '#facc15', '#111'], ['STREET KINGS', '#fff', '#1d4ed8'], ['NO REFS', '#111', '#f472b6'],
      ['IRON VIPERS', '#fff', '#b91c1c'], ['SLIDE TACKLES WELCOME', '#111', '#4ade80'], ['3v3', '#fff', '#7c3aed']];
    const seg = w / ads.length;
    ads.forEach(([text, fg, bg], i) => {
      g.fillStyle = bg;
      g.fillRect(i * seg, 0, seg, h);
      g.fillStyle = fg;
      g.font = '900 38px Impact, "Arial Black", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, i * seg + seg / 2, h / 2 + 2);
    });
  });
}

function ballTexture() {
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#f8fafc';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#111827';
    const patch = (cx, cy, r) => {
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
    };
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 6; i++) patch(((i + (row % 2) * 0.5) / 6) * w, ((row + 0.5) / 3) * h, 26);
    }
    patch(w / 2, 6, 60);
    patch(w / 2, h - 6, 60);
  });
}

const glowTexture = () => canvasTex(64, 64, (g, w) => {
  const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, w);
});

function shirtTexture(color, number, name, back) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, 0, w, 10);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (back) {
      g.font = '700 18px system-ui, sans-serif';
      g.fillText(name.toUpperCase(), w / 2, 24);
      g.font = '900 70px Impact, "Arial Black", sans-serif';
      g.fillText(String(number), w / 2, 78);
    } else {
      g.font = '900 44px Impact, "Arial Black", sans-serif';
      g.fillText(String(number), w / 2, h / 2 + 6);
    }
  });
}

function faceTexture(look) {
  return canvasTex(128, 128, (g, w) => {
    g.fillStyle = look.skin;
    g.fillRect(0, 0, w, w);
    g.fillStyle = '#111';
    if (look.face === 'mask') {
      g.fillRect(8, 40, 112, 30);
      g.fillStyle = '#fff';
      g.fillRect(32, 48, 18, 12);
      g.fillRect(78, 48, 18, 12);
    } else {
      g.fillRect(36, 44, 14, 20);
      g.fillRect(78, 44, 14, 20);
    }
    g.strokeStyle = '#111';
    g.lineWidth = 6;
    g.lineCap = 'round';
    g.beginPath();
    if (look.face === 'angry') {
      g.moveTo(30, 34); g.lineTo(52, 42);
      g.moveTo(98, 34); g.lineTo(76, 42);
      g.moveTo(44, 96); g.lineTo(84, 96);
    } else if (look.face === 'smirk') {
      g.moveTo(44, 92); g.quadraticCurveTo(70, 100, 90, 84);
    } else if (look.face === 'grin') {
      g.arc(64, 82, 20, 0.1 * Math.PI, 0.9 * Math.PI);
    } else {
      g.arc(64, 80, 18, 0.15 * Math.PI, 0.85 * Math.PI);
    }
    g.stroke();
    if (look.face === 'scar') {
      g.strokeStyle = '#7f1d1d';
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(84, 30); g.lineTo(98, 70); g.stroke();
    }
  });
}

// ---------------------------------------------------------------------------
// Characters

function buildAvatar({ shirt, shorts, look, name }) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const std = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.6, ...opts });
  const m = {
    shirt: std({ color: shirt, roughness: 0.55 }),
    shorts: std({ color: shorts, roughness: 0.7 }),
    skin: std({ color: look.skin }),
    shoe: std({ color: 0x0f0f12, roughness: 0.35 }),
    hair: std({ color: look.hair, roughness: 0.5 }),
  };
  const meshes = [];
  const box = (w, h, d, mat, parent, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    meshes.push(mesh);
    return mesh;
  };
  const limb = (x, y) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    body.add(pivot);
    return pivot;
  };
  const legL = limb(-0.27, 1.05);
  const legR = limb(0.27, 1.05);
  for (const leg of [legL, legR]) {
    box(0.46, 1.05, 0.5, m.shorts, leg, 0, -0.52);
    box(0.48, 0.2, 0.68, m.shoe, leg, 0, -0.98, 0.09);
  }
  const front = std({ map: shirtTexture(shirt, look.number, name, false), roughness: 0.55 });
  const back = std({ map: shirtTexture(shirt, look.number, name, true), roughness: 0.55 });
  box(1.15, 1.1, 0.62, [m.shirt, m.shirt, m.shirt, m.shirt, front, back], body, 0, 1.6);
  const armL = limb(-0.78, 2.1);
  const armR = limb(0.78, 2.1);
  for (const arm of [armL, armR]) {
    box(0.38, 0.95, 0.42, m.shirt, arm, 0, -0.45);
    box(0.36, 0.24, 0.4, look === LOOKS.keeper ? std({ color: 0xf8fafc }) : m.skin, arm, 0, -1.02);
  }
  const head = new THREE.Group();
  head.position.y = 2.6;
  body.add(head);
  const face = std({ map: faceTexture(look) });
  box(0.82, 0.82, 0.82, [m.skin, m.skin, m.skin, m.skin, face, m.skin], head);
  switch (look.style) {
    case 'spikes':
      for (const [x, z, r] of [[-0.22, -0.1, -0.3], [0, 0.05, 0], [0.22, -0.1, 0.3], [0, -0.25, 0], [-0.1, 0.25, -0.15], [0.12, 0.25, 0.15]]) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 4), m.hair);
        c.position.set(x, 0.62, z);
        c.rotation.z = r;
        c.castShadow = true;
        head.add(c);
      }
      box(0.86, 0.16, 0.86, m.hair, head, 0, 0.44);
      break;
    case 'band':
      box(0.86, 0.22, 0.86, std({ color: 0x1f1147 }), head, 0, 0.42);
      box(0.88, 0.13, 0.88, m.hair, head, 0, 0.24);
      break;
    case 'flat':
      box(0.86, 0.34, 0.86, m.hair, head, 0, 0.55);
      break;
    case 'mohawk':
      box(0.18, 0.5, 0.86, m.hair, head, 0, 0.62);
      break;
    case 'hood':
      box(0.96, 0.24, 0.96, m.hair, head, 0, 0.52);
      box(0.96, 0.96, 0.16, m.hair, head, 0, 0.02, -0.46);
      box(0.12, 0.96, 0.96, m.hair, head, -0.47, 0.02, -0.02);
      box(0.12, 0.96, 0.96, m.hair, head, 0.47, 0.02, -0.02);
      break;
    case 'bandana':
      box(0.86, 0.2, 0.86, std({ color: 0xdc2626 }), head, 0, 0.28);
      box(0.84, 0.16, 0.84, m.hair, head, 0, 0.47);
      box(0.18, 0.18, 0.22, std({ color: 0xdc2626 }), head, 0.1, 0.24, -0.52);
      break;
    case 'cap':
      box(0.88, 0.2, 0.88, m.hair, head, 0, 0.5);
      box(0.88, 0.06, 0.42, m.hair, head, 0, 0.42, 0.6);
      break;
    default:
      break;
  }
  root.scale.setScalar(look.scale * 1.08);
  return { root, body, legL, legR, armL, armR, head, meshes };
}

function flatRing(inner, outer, color, opacity) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

// ---------------------------------------------------------------------------

export function createPitch3D(container, handlers = {}) {
  const stage = document.createElement('div');
  stage.className = 'stage3d';
  container.append(stage);
  // Phones get a lighter setup: fewer pixels and a smaller shadow map.
  const lite = window.matchMedia('(max-width: 760px)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lite ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  stage.append(renderer.domElement);
  const labelLayer = document.createElement('div');
  labelLayer.className = 'p3-labels';
  stage.append(labelLayer);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060a16);
  scene.fog = new THREE.Fog(0x060a16, 95, 200);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 500);
  camera.position.set(0, 42, 56);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.maxPolarAngle = 1.45;
  controls.minDistance = 10;
  controls.maxDistance = 130;

  // ---- lights -------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x9db4ff, 0x1c2a18, 0.7));
  scene.add(new THREE.AmbientLight(0x3c4670, 0.4));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
  sun.position.set(18, 55, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(lite ? 1024 : 2048, lite ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 30, bottom: -30, near: 10, far: 140 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  // ---- world --------------------------------------------------------------
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  scene.add(ground);

  const turfTex = pitchTexture();
  turfTex.anisotropy = maxAniso;
  const turf = new THREE.Mesh(new THREE.PlaneGeometry(70, 40), new THREE.MeshStandardMaterial({ map: turfTex, roughness: 0.92 }));
  turf.rotation.x = -Math.PI / 2;
  turf.receiveShadow = true;
  scene.add(turf);

  const metal = new THREE.MeshStandardMaterial({ color: 0x5b6474, metalness: 0.7, roughness: 0.4 });
  const fenceMat = (rx, ry) => {
    const t = chainTexture();
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    return new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, metalness: 0.5, roughness: 0.5 });
  };
  const fence = (w, x, z, rotY) => {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, 6), fenceMat(w / 1.2, 5));
    panel.position.set(x, 3, z);
    panel.rotation.y = rotY;
    scene.add(panel);
    const n = Math.round(w / 6);
    for (let i = 0; i <= n; i++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6.3, 8), metal);
      const along = -w / 2 + (i * w) / n;
      post.position.set(x + Math.cos(rotY) * along, 3.15, z - Math.sin(rotY) * along);
      post.castShadow = true;
      scene.add(post);
    }
  };
  fence(72, 0, -21, 0);
  fence(42, -36, 0, Math.PI / 2);
  fence(42, 36, 0, Math.PI / 2);
  // The camera side gets low advertising boards so the view stays clear.
  const boardTex = boardTexture();
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.5, emissive: 0xffffff, emissiveMap: boardTex, emissiveIntensity: 0.35 });
  const boards = new THREE.Mesh(new THREE.BoxGeometry(72, 1.1, 0.25), [metal, metal, metal, metal, boardMat, boardMat]);
  boards.position.set(0, 0.55, 21);
  boards.castShadow = true;
  scene.add(boards);

  const wallTex = wallTexture();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(80, 6, 0.8), [metal, metal, metal, metal,
    new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, emissive: 0xffffff, emissiveMap: wallTex, emissiveIntensity: 0.12 }), metal]);
  wall.position.set(0, 3, -25);
  wall.receiveShadow = true;
  scene.add(wall);

  // City skyline
  const winTex = windowTexture();
  for (let i = 0; i < 26; i++) {
    const w = 10 + Math.random() * 10;
    const h = 14 + Math.random() * 46;
    const d = 10 + Math.random() * 8;
    const t = winTex.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(w / 10, h / 20);
    t.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.9, roughness: 0.8 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const ring = i < 14 ? { x: -100 + i * 15, z: -48 - Math.random() * 25 } : { x: (i % 2 ? -1 : 1) * (60 + Math.random() * 25), z: -30 + ((i - 14) / 12) * 70 };
    b.position.set(ring.x, h / 2, ring.z);
    scene.add(b);
  }

  // Floodlights
  const glowTex = glowTexture();
  for (const [x, z] of [[-38, -23], [38, -23], [-38, 23], [38, 23]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 22, 8), metal);
    pole.position.set(x, 11, z);
    pole.castShadow = true;
    scene.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 0.6), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff5d6, emissiveIntensity: 2.2 }));
    head.position.set(x * 0.97, 22, z * 0.97);
    head.lookAt(0, 0, 0);
    scene.add(head);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff1c9, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.position.copy(head.position);
    glow.scale.set(16, 16, 1);
    scene.add(glow);
  }

  // Stars
  {
    const pts = new Float32Array(600 * 3);
    for (let i = 0; i < 600; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 200 + Math.random() * 60;
      pts.set([Math.cos(a) * r, 60 + Math.random() * 120, Math.sin(a) * r], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xc7d2fe, size: 0.9, fog: false })));
  }

  // Goals
  const netTex = netTexture();
  for (const side of [-1, 1]) {
    const g = new THREE.Group();
    g.position.x = side * 30;
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.2 });
    const bar = (len, x, y, z, rot) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, len, 10), white);
      c.position.set(x, y, z);
      if (rot) c.rotation.set(rot[0], rot[1], rot[2]);
      c.castShadow = true;
      g.add(c);
    };
    const H = 2.7;
    const D = 2.3 * side;
    bar(H, 0, H / 2, -4);
    bar(H, 0, H / 2, 4);
    bar(8.2, 0, H, 0, [Math.PI / 2, 0, 0]);
    bar(H, D, H / 2, -4);
    bar(H, D, H / 2, 4);
    bar(8.2, D, H, 0, [Math.PI / 2, 0, 0]);
    for (const z of [-4, 4]) bar(Math.abs(D), D / 2, H, z, [0, 0, Math.PI / 2]);
    const net = (w, h, rx, ry) => {
      const t = netTex.clone();
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(w * 2.5, h * 2.5);
      t.needsUpdate = true;
      return new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
    };
    const back = new THREE.Mesh(new THREE.PlaneGeometry(8, H), net(8, H));
    back.position.set(D, H / 2, 0);
    back.rotation.y = Math.PI / 2;
    g.add(back);
    for (const z of [-4, 4]) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(D), H), net(Math.abs(D), H));
      s.position.set(D / 2, H / 2, z);
      g.add(s);
    }
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(D), 8), net(Math.abs(D), 8));
    roof.position.set(D / 2, H, 0);
    roof.rotation.x = -Math.PI / 2;
    g.add(roof);
    scene.add(g);
  }

  // ---- ball ---------------------------------------------------------------
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.35, emissive: 0x000000 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 20), ballMat);
  ball.castShadow = true;
  ball.position.set(0, BALL_R, 0);
  scene.add(ball);

  // ---- effects --------------------------------------------------------------
  const fx = [];
  const addFx = (obj, life, step) => {
    scene.add(obj);
    fx.push({ obj, life, age: 0, step });
  };
  const shockwave = (pos, color = 0xfbbf24) => {
    const ring = flatRing(0.7, 1.1, color, 0.9);
    ring.position.set(pos.x, 0.06, pos.z);
    addFx(ring, 0.7, (o, u) => {
      o.scale.setScalar(1 + u * 6.5);
      o.material.opacity = 0.9 * (1 - u);
    });
  };
  const puff = (pos, color = 0xc4b5fd) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, wireframe: true }));
    s.position.set(pos.x, 1.4, pos.z);
    addFx(s, 0.5, (o, u) => {
      o.scale.setScalar(0.6 + u * 2.4);
      o.material.opacity = 0.7 * (1 - u);
    });
  };
  const trail = (pos, color) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.position.copy(pos);
    sp.scale.setScalar(1.5);
    addFx(sp, 0.4, (o, u) => {
      o.material.opacity = 0.85 * (1 - u);
      o.scale.setScalar(1.5 * (1 - u * 0.6));
    });
  };
  const aura = (av) => {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.07, 8, 36), new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.9 }));
    t.rotation.x = Math.PI / 2;
    addFx(t, 1.6, (o, u, now) => {
      o.position.set(av.pos.x, 3.7 + Math.sin(now * 0.01) * 0.12, av.pos.z);
      o.scale.setScalar(1 + Math.sin(now * 0.015) * 0.15);
      o.material.opacity = 0.9 * (1 - u * u);
    });
  };
  // Confetti: one instanced mesh, reused for every goal.
  const CONF = 260;
  const confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.28, 0.42), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), CONF);
  confetti.frustumCulled = false;
  const confData = Array.from({ length: CONF }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), life: 0 }));
  const dummy = new THREE.Object3D();
  for (let i = 0; i < CONF; i++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    confetti.setMatrixAt(i, dummy.matrix);
    confetti.setColorAt(i, new THREE.Color(0xffffff));
  }
  scene.add(confetti);
  const burst = (pos, teamColor) => {
    const palette = [teamColor, 0xffffff, 0xfacc15];
    const col = new THREE.Color();
    confData.forEach((c, i) => {
      c.p.set(pos.x + (Math.random() - 0.5) * 2, pos.y + Math.random(), pos.z + (Math.random() - 0.5) * 6);
      c.v.set((Math.random() - 0.5) * 10 - Math.sign(pos.x) * 4, 7 + Math.random() * 9, (Math.random() - 0.5) * 12);
      c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      c.life = 2.2 + Math.random() * 1.2;
      confetti.setColorAt(i, col.setHex(palette[i % palette.length]));
    });
    confetti.instanceColor.needsUpdate = true;
  };

  // ---- players & keepers ----------------------------------------------------
  const avatars = new Map();
  const pickables = [];
  const keepers = {};
  for (const team of ['home', 'away']) {
    const k = buildAvatar({ ...KEEPER[team], look: LOOKS.keeper, name: 'Keeper' });
    k.pos = new THREE.Vector3(team === 'home' ? -29 : 29, 0, 0);
    k.target = k.pos;
    k.prev = k.pos.clone();
    k.phase = 0;
    k.facing = team === 'home' ? Math.PI / 2 : -Math.PI / 2;
    k.root.position.copy(k.pos);
    k.dive = null;
    scene.add(k.root);
    keepers[team] = k;
  }

  function ensureAvatars(match) {
    if (avatars.size) return;
    for (const p of match.players) {
      const look = LOOKS[p.id] || LOOKS.keeper;
      const av = buildAvatar({ shirt: TEAM[p.team], shorts: TEAM_DARK[p.team], look, name: p.name });
      av.idx = p.idx;
      av.team = p.team;
      av.pos = new THREE.Vector3();
      av.target = new THREE.Vector3();
      av.prev = new THREE.Vector3();
      av.facing = p.team === 'home' ? Math.PI / 2 : -Math.PI / 2;
      av.phase = 0;
      av.pieces = [];
      av.acts = [];
      av.ring = flatRing(0.95, 1.2, TEAM[p.team], 0.85);
      av.meRing = flatRing(1.38, 1.62, 0xfacc15, 0.95);
      av.targetRing = flatRing(1.1, 1.8, 0xfde047, 0.8);
      for (const r of [av.ring, av.meRing, av.targetRing]) {
        r.position.y = 0.04;
        scene.add(r);
      }
      av.stars = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: 0xfde047 }));
        const a = (i / 3) * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6);
        av.stars.add(s);
      }
      scene.add(av.stars);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(1.8, 3.4, 1.8), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 1.7;
      hit.userData.idx = p.idx;
      av.root.add(hit);
      pickables.push(hit);
      scene.add(av.root);

      const label = document.createElement('div');
      label.className = `p3-label ${p.team}`;
      label.innerHTML = '<span class="p3-status"></span><span class="p3-name"></span><span class="p3-sta"><i></i></span>';
      label.querySelector('.p3-name').textContent = p.name;
      label.addEventListener('click', () => handlers.onPlayerClick?.(p.idx));
      labelLayer.append(label);
      av.label = label;
      avatars.set(p.idx, av);
    }
  }

  // ---- layout helpers ---------------------------------------------------
  // Spread out players who share a cell so they don't stand inside each other.
  function targetPositions(match) {
    const groups = new Map();
    for (const p of match.players) {
      const key = `${p.x},${p.y}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p.idx);
    }
    const out = new Map();
    for (const p of match.players) {
      const g = groups.get(`${p.x},${p.y}`);
      const i = g.indexOf(p.idx);
      const v = toV(p);
      if (g.length > 1) {
        const a = (i / g.length) * Math.PI * 2 + 0.6;
        v.x += Math.cos(a) * 1.7;
        v.z += Math.sin(a) * 1.7;
      }
      out.set(p.idx, v);
    }
    return out;
  }

  const feet = (av, out = new THREE.Vector3()) => {
    out.set(Math.sin(av.facing), 0, Math.cos(av.facing)).multiplyScalar(0.95).add(av.pos);
    out.y = BALL_R;
    return out;
  };

  // ---- state --------------------------------------------------------------
  let match = null;
  let youSlot = -1;
  let targets = new Set();
  let markers = [];
  let markerObjs = [];
  let tl = null; // current replay timeline
  let camMode = 'follow';
  let shakeUntil = 0;
  const look = new THREE.Vector3(0, 0, 0);
  const desiredPos = new THREE.Vector3();
  const desiredLook = new THREE.Vector3();

  function snapAll(positions) {
    for (const av of avatars.values()) {
      av.target.copy(positions.get(av.idx));
      av.pos.copy(av.target);
      av.prev.copy(av.target);
      av.pieces = [];
      av.acts = [];
    }
    tl = null;
    const carrier = avatars.get(match.ballCarrier);
    if (carrier) feet(carrier, ball.position);
  }

  // Turn the events of one resolved turn into a timeline.
  function buildTimeline(events, prevHolder, positions) {
    const T = { start: performance.now(), segs: [], effects: [], holderBefore: prevHolder, holderAfter: match.ballCarrier, rest: null, goal: null };
    const avAt = (i) => avatars.get(i);
    const W = (p, h = 0) => toV(p, h);
    let cur = 120;
    const pieceFor = new Map(); // players with scripted movement

    const kick = (i, t) => avAt(i)?.acts.push({ type: 'kick', t0: t - 80, t1: t + 260 });
    const addSeg = (seg, t) => {
      const from = seg.explicit ? W(seg.from, BALL_R) : null;
      let to = W(seg.to, BALL_R);
      const d = (from ?? W(seg.from)).distanceTo(to);
      const speed = { pass: 21, loft: 17, shoot: 32, power: 44, inferno: 40, venom: 28, deflect: 16, loose: 11 }[seg.style] ?? 20;
      const dur = clamp((d / speed) * 1000, seg.style === 'loose' ? 320 : 260, 1400);
      let arc = 0.05 * d;
      if (seg.style === 'loft') arc = 0.2 * d + 1;
      else if (seg.style === 'shoot') arc = 0.05 * d + 0.4;
      else if (seg.style === 'power' || seg.style === 'inferno') arc = 0.02 * d;
      else if (seg.style === 'venom') arc = 0.08 * d;
      else if (seg.style === 'deflect' || seg.style === 'loose') arc = 0.7 + 0.12 * d;
      if (seg.end) to = to.setY(seg.end);
      T.segs.push({ t0: t, t1: t + dur, from, to, arc, style: seg.style, curve: seg.style === 'venom' ? d * 0.18 * (seg.to.y >= 1 ? 1 : -1) : 0 });
      return t + dur;
    };
    const fall = (i, t, long = false) => avAt(i)?.acts.push({ type: 'fall', t0: t, t1: t + (long ? 1600 : 1200) });
    const effect = (t, fn) => T.effects.push({ t, fn, done: false });

    for (const e of events) {
      const actor = e.actor != null ? avAt(e.actor) : null;
      if (e.slide && actor) {
        const t0 = cur;
        const from = actor.pos.clone();
        const to = W(e.slide.to);
        // Land just short of the victim, not on top of them.
        const dirV = to.clone().sub(from);
        if (dirV.length() > 1.2) to.sub(dirV.normalize().multiplyScalar(0.9));
        actor.pieces.push({ from, to, t0, t1: t0 + 460 });
        pieceFor.set(e.actor, t0 + 460);
        actor.acts.push({ type: 'slide', t0, t1: t0 + 650 });
        if (e.ok && e.target != null) fall(e.target, t0 + 340);
        if (e.holder != null) T.segs.push({ t0: t0 + 340, t1: t0 + 640, from: null, to: null, toHolder: e.holder, arc: 0.6, style: 'loose' });
        if (e.kind.startsWith('rocket')) effect(t0, () => shockwave(from, 0xf97316));
        cur += 420;
        continue;
      }
      if (e.teleport && actor) {
        const t0 = cur;
        const from = W(e.teleport.from);
        const to = W(e.teleport.to);
        actor.pieces.push({ from, to, t0, t1: t0 + 1 });
        pieceFor.set(e.actor, t0 + 1);
        effect(t0, () => { puff(from); puff(to); });
        cur += 320;
        continue;
      }
      switch (e.kind) {
        case 'stomp':
          actor?.acts.push({ type: 'jump', t0: cur, t1: cur + 520 });
          effect(cur + 420, () => {
            shockwave(actor.pos, 0xfbbf24);
            shakeUntil = performance.now() + 350;
          });
          cur += 450;
          break;
        case 'stompResult':
          for (const v of e.victims || []) fall(v, cur);
          cur += 150;
          break;
        case 'mindread':
          if (actor) effect(cur, () => aura(actor));
          cur += 150;
          break;
        case 'dribbleOk': {
          const seg = e.path[0];
          const t0 = cur;
          actor.pieces.push({ from: actor.pos.clone(), to: W(seg.to), t0, t1: t0 + 850 });
          pieceFor.set(e.actor, t0 + 850);
          cur += 850;
          break;
        }
        case 'dribbleLost':
        case 'stompSteal':
          T.segs.push({ t0: cur, t1: cur + 380, from: null, to: null, toHolder: e.holder, arc: 0.7, style: 'loose' });
          cur += 380;
          break;
        default:
          if (e.path?.length) {
            if (e.actor != null && !e.kind.startsWith('restart')) kick(e.actor, cur);
            if (e.kind.startsWith('restart')) cur += 350;
            let t = cur;
            e.path.forEach((seg, i) => {
              const shotSeg = e.kind.startsWith('goal_') || e.kind === 'shotSaved' || e.kind === 'shotWide' || e.kind === 'shotPost';
              const end = !shotSeg || i > 0 ? null : e.goal ? (seg.style === 'venom' ? 2.1 : seg.style === 'power' ? 1.7 : 1.2) : e.kind === 'shotWide' ? 2.3 : e.kind === 'shotPost' ? 1.4 : 1.0;
              const s2 = { ...seg, end, explicit: e.kind.startsWith('restart') };
              const segStart = t;
              t = addSeg(s2, t);
              if (shotSeg && i === 0) {
                const keeper = keepers[e.team === 'home' ? 'away' : 'home'];
                const side = Math.sign(wz(seg.to) - keeper.pos.z) || 1;
                const lead = e.goal ? 60 : 140;
                keeper.dive = { t0: T.start + Math.max(segStart, t - 380 - lead), t1: T.start + t + 700, side: e.goal && Math.random() < 0.5 ? -side : side };
              }
            });
            if (e.goal) {
              T.goal = { at: t, team: e.team, actor: e.actor, event: e };
              effect(t, () => {
                burst(new THREE.Vector3(Math.sign(wx(e.path[0].to)) * 31, 2, wz(e.path[0].to)), TEAM[e.team]);
                shakeUntil = performance.now() + 600;
                handlers.onGoal?.(e);
              });
            }
            cur = t + (e.kind === 'shotSaved' ? 200 : 60);
          }
      }
    }

    // Everyone else walks to where the server says they ended up.
    const reset = T.goal ? T.goal.at + 2000 : null;
    for (const av of avatars.values()) {
      const target = positions.get(av.idx);
      if (reset != null) {
        av.pieces.push({ from: null, to: target, t0: reset, t1: reset + 800 });
        if (avatars.get(T.goal.actor)?.team === av.team) av.acts.push({ type: 'celebrate', t0: T.goal.at, t1: reset });
        continue;
      }
      const scriptedUntil = pieceFor.get(av.idx);
      if (scriptedUntil != null) {
        const lastTo = av.pieces.at(-1).to;
        if (lastTo.distanceTo(target) > 0.3) av.pieces.push({ from: null, to: target, t0: scriptedUntil + 80, t1: scriptedUntil + 680 });
      } else if (av.pos.distanceTo(target) > 0.05) {
        av.pieces.push({ from: null, to: target, t0: 0, t1: 1050 });
      }
    }
    if (reset != null) T.rest = { until: reset + 400 };
    const lastSeg = T.segs.reduce((m, s) => Math.max(m, s.t1), 0);
    const lastPiece = Math.max(0, ...[...avatars.values()].flatMap((a) => a.pieces.map((p) => p.t1)));
    T.duration = Math.max(cur, lastSeg, lastPiece, 900) + 250;
    return T;
  }

  // ---- public: update -------------------------------------------------------
  function update(opts) {
    const prevCarrier = match?.ballCarrier;
    match = opts.match;
    youSlot = opts.youSlot ?? -1;
    targets = opts.targets || new Set();
    ensureAvatars(match);
    const positions = targetPositions(match);
    let duration = 0;

    if (opts.playback && prevCarrier != null) {
      // Finish whatever was still playing, then replay the new turn.
      if (tl) {
        for (const av of avatars.values()) {
          av.pos.copy(av.target);
          av.pieces = [];
          av.acts = [];
        }
        const holder = avatars.get(tl.holderAfter);
        if (holder) feet(holder, ball.position);
      }
      for (const av of avatars.values()) av.target.copy(positions.get(av.idx));
      tl = buildTimeline(opts.playback, prevCarrier, positions);
      duration = tl.duration;
    } else if (prevCarrier == null) {
      snapAll(positions);
    } else {
      for (const av of avatars.values()) av.target.copy(positions.get(av.idx));
    }

    for (const p of match.players) {
      const av = avatars.get(p.idx);
      av.grounded = p.grounded;
      av.dazed = p.dazed;
      av.meRing.visible = p.idx === youSlot;
      av.targetRing.visible = targets.has(p.idx);
      const label = av.label;
      label.classList.toggle('me', p.idx === youSlot);
      label.classList.toggle('target', targets.has(p.idx));
      label.querySelector('.p3-status').textContent = p.grounded ? '💤' : p.dazed ? '💫' : '';
      const sta = label.querySelector('.p3-sta i');
      sta.style.width = `${Math.max(0, (p.stamina / p.maxStamina) * 100)}%`;
      sta.classList.toggle('low', p.stamina < 25);
      label.title = `${p.name} (${p.role}) · stamina ${p.stamina}/${p.maxStamina}`;
    }
    setMarkers(opts.markers || []);
    return duration;
  }

  function setMarkers(list) {
    const key = JSON.stringify(list.map((m) => [m.x, m.y, m.chance, m.dir]));
    if (key === JSON.stringify(markers.map((m) => [m.x, m.y, m.chance, m.dir]))) return;
    markers = list;
    for (const o of markerObjs) {
      scene.remove(o.ring);
      o.ring.geometry.dispose();
      o.ring.material.dispose();
      o.label.remove();
    }
    markerObjs = list.map((mk) => {
      const ring = flatRing(0.9, 1.35, 0xfacc15, 0.85);
      ring.position.copy(toV(mk)).setY(0.05);
      ring.userData.dir = mk.dir;
      scene.add(ring);
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'p3-marker';
      label.textContent = `${mk.chance}%`;
      label.title = mk.label;
      label.addEventListener('click', () => handlers.onMarkerClick?.(mk.dir));
      labelLayer.append(label);
      return { ring, label, pos: toV(mk).setY(0.2), dir: mk.dir };
    });
  }

  // ---- input --------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  const pick = (ev) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const mk = raycaster.intersectObjects(markerObjs.map((o) => o.ring))[0];
    if (mk) return { marker: mk.object.userData.dir };
    const hit = raycaster.intersectObjects(pickables)[0];
    return hit ? { idx: hit.object.userData.idx } : null;
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 6) return;
    const hit = pick(ev);
    if (hit?.marker) handlers.onMarkerClick?.(hit.marker);
    else if (hit?.idx != null) handlers.onPlayerClick?.(hit.idx);
  });
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (ev.buttons) return;
    const hit = pick(ev);
    renderer.domElement.style.cursor = hit?.marker || (hit?.idx != null && targets.has(hit.idx)) ? 'pointer' : camMode === 'free' ? 'grab' : 'default';
  });

  // ---- camera -------------------------------------------------------------
  function setCamera(mode) {
    camMode = mode;
    controls.enabled = mode === 'free';
    if (controls.enabled) controls.target.copy(look);
  }

  function updateCamera(dt, now) {
    if (camMode === 'free') {
      controls.update();
      look.copy(controls.target);
    } else {
      const aspect = camera.aspect;
      const narrow = aspect < 1.45;
      const b = ball.position;
      const me = avatars.get(youSlot);
      if (camMode === 'me' && me) {
        const dirX = me.team === 'home' ? 1 : -1;
        desiredLook.set(me.pos.x + dirX * 11, 1, me.pos.z * 0.6);
        desiredPos.set(me.pos.x - dirX * (narrow ? 15 : 13), narrow ? 10 : 8.5, me.pos.z * 1.1);
      } else if (camMode === 'wide') {
        desiredLook.set(0, 0, 1);
        desiredPos.set(0, narrow ? 64 : 46, narrow ? 68 : 58);
      } else if (camMode === 'top') {
        desiredLook.set(0, 0, 0);
        desiredPos.set(0, narrow ? 100 : 74, 0.01);
      } else {
        desiredLook.set(clamp(b.x * 0.9, -20, 20), 0, clamp(b.z * 0.4, -5, 5));
        desiredPos.set(desiredLook.x, narrow ? 26 : 19, desiredLook.z + (narrow ? 34 : 27));
      }
      const k = 1 - Math.exp(-dt * 2.6);
      camera.position.lerp(desiredPos, k);
      look.lerp(desiredLook, k);
      camera.lookAt(look);
    }
    if (now < shakeUntil && !reduceMotion) {
      const a = (shakeUntil - now) / 600;
      camera.position.x += (Math.random() - 0.5) * a;
      camera.position.y += (Math.random() - 0.5) * a;
    }
  }

  // ---- per-frame animation ----------------------------------------------
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  function animateAvatar(av, t, dt, now) {
    // Position: follow scripted pieces during a replay, otherwise glide to target.
    av.prev.copy(av.pos);
    if (t != null && av.pieces.length) {
      let p = null;
      for (const piece of av.pieces) {
        if (t >= piece.t0) p = piece;
      }
      if (p) {
        if (!p.from) p.from = av.pos.clone();
        av.pos.lerpVectors(p.from, p.to, ease(clamp01((t - p.t0) / Math.max(1, p.t1 - p.t0))));
      }
    } else if (t == null) {
      av.pos.lerp(av.target, 1 - Math.exp(-dt * 5));
    }
    const moved = tmp.subVectors(av.pos, av.prev);
    moved.y = 0;
    const dist = moved.length();
    const speed = dt > 0 ? dist / dt : 0;
    av.phase += dist * 1.7;

    // Facing: where you're running, otherwise toward the ball.
    let want = av.facing;
    if (speed > 1.2) want = Math.atan2(moved.x, moved.z);
    else {
      tmp2.subVectors(ball.position, av.pos);
      if (tmp2.lengthSq() > 0.5) want = Math.atan2(tmp2.x, tmp2.z);
    }
    av.facing = angleLerp(av.facing, want, 1 - Math.exp(-dt * 8));

    // Pose
    const run = Math.min(1, speed / 6);
    let swing = Math.sin(av.phase) * 0.95 * run;
    let bodyX = 0;
    let lift = 0;
    let lieY = 0;
    let armUp = 0;
    let kick = 0;
    let roll = 0;
    let stars = av.dazed;
    const act = t != null ? av.acts.find((a) => t >= a.t0 && t < a.t1) : null;
    if (act) {
      const u = clamp01((t - act.t0) / (act.t1 - act.t0));
      if (act.type === 'slide') {
        bodyX = -1.2 * Math.min(1, u * 4) * (u > 0.8 ? (1 - u) * 5 : 1);
        lieY = 0.25 * Math.min(1, u * 4);
        swing = 0;
        kick = -1.2;
      } else if (act.type === 'fall') {
        const down = u < 0.25 ? u / 0.25 : u > 0.8 ? (1 - u) / 0.2 : 1;
        bodyX = -Math.PI / 2 * down;
        lieY = 0.3 * down;
        swing = 0;
        stars = true;
      } else if (act.type === 'kick') {
        kick = -1.5 * Math.sin(u * Math.PI);
        armUp = 0.5 * Math.sin(u * Math.PI);
      } else if (act.type === 'jump') {
        lift = Math.sin(u * Math.PI) * 1.6;
        armUp = 2.6 * Math.sin(u * Math.PI);
      } else if (act.type === 'celebrate') {
        lift = Math.abs(Math.sin(now * 0.009)) * 1.1;
        armUp = 2.8;
        swing = 0;
      }
    } else if (av.grounded && (t == null || t > (tl?.duration ?? 0) * 0.5)) {
      bodyX = -Math.PI / 2;
      lieY = 0.3;
      swing = 0;
    }
    if (av.dive) {
      const u = clamp01((now - av.dive.t0) / (av.dive.t1 - av.dive.t0));
      if (u > 0 && u < 1) {
        const k = u < 0.35 ? u / 0.35 : u > 0.75 ? (1 - u) / 0.25 : 1;
        roll = av.dive.side * (Math.PI / 2.2) * k;
        lift = Math.sin(Math.min(1, u / 0.5) * Math.PI) * 0.8;
        armUp = 2.8 * k;
      }
    }
    const k = 1 - Math.exp(-dt * 14);
    av.body.rotation.x += (bodyX - av.body.rotation.x) * k;
    av.body.rotation.z += (roll - av.body.rotation.z) * k;
    av.body.position.y += (lieY - av.body.position.y) * k;
    av.legL.rotation.x = swing;
    av.legR.rotation.x = kick || -swing;
    av.armL.rotation.x = -swing * 0.8 - armUp;
    av.armR.rotation.x = swing * 0.8 - armUp;
    av.armL.rotation.z = armUp ? 0.25 : 0;
    av.armR.rotation.z = armUp ? -0.25 : 0;
    av.root.position.set(av.pos.x, lift + (run > 0.1 ? Math.abs(Math.sin(av.phase)) * 0.12 : 0), av.pos.z);
    av.root.rotation.y = av.facing;

    if (av.ring) {
      av.ring.position.set(av.pos.x, 0.04, av.pos.z);
      av.meRing.position.set(av.pos.x, 0.045, av.pos.z);
      av.targetRing.position.set(av.pos.x, 0.05, av.pos.z);
      if (av.targetRing.visible) av.targetRing.scale.setScalar(1 + Math.sin(now * 0.008) * 0.12);
      av.meRing.material.opacity = 0.7 + Math.sin(now * 0.005) * 0.25;
      av.stars.visible = stars;
      if (stars) {
        av.stars.position.set(av.pos.x, (av.grounded || act?.type === 'fall' ? 1.2 : 3.7), av.pos.z);
        av.stars.rotation.y += dt * 4;
      }
    }
  }

  function animateKeeper(team, k, dt, now) {
    const goalX = team === 'home' ? -29 : 29;
    const want = clamp(ball.position.z * 0.3, -3, 3);
    k.pos.x = goalX;
    k.pos.z += (want - k.pos.z) * (1 - Math.exp(-dt * 3));
    if (k.dive) {
      const u = clamp01((now - k.dive.t0) / (k.dive.t1 - k.dive.t0));
      if (u > 0 && u < 1) k.pos.z += k.dive.side * dt * 9 * (u < 0.4 ? 1 : 0);
      if (u >= 1) k.dive = null;
    }
    k.facing = team === 'home' ? Math.PI / 2 : -Math.PI / 2;
    k.dazed = false;
    animateAvatar(k, null, dt, now);
  }

  function ballFrame(t, dt) {
    const before = tmp2.copy(ball.position);
    let shotStyle = null;
    if (t != null && tl) {
      const segs = tl.segs;
      const active = segs.find((s) => t >= s.t0 && t < s.t1);
      if (active) {
        if (!active.fromV) active.fromV = active.from ? active.from.clone() : ball.position.clone();
        if (active.toHolder != null) {
          const h = avatars.get(active.toHolder);
          active.to = feet(h, new THREE.Vector3());
        }
        const u = clamp01((t - active.t0) / (active.t1 - active.t0));
        ball.position.lerpVectors(active.fromV, active.to, active.style === 'power' || active.style === 'inferno' ? u : ease(u) * 0.3 + u * 0.7);
        ball.position.y += active.arc * hump(u);
        if (active.curve) {
          const dir = tmp.subVectors(active.to, active.fromV).setY(0).normalize();
          ball.position.x += -dir.z * active.curve * hump(u);
          ball.position.z += dir.x * active.curve * hump(u);
        }
        if (['shoot', 'power', 'inferno', 'venom'].includes(active.style)) shotStyle = active.style;
      } else {
        const started = segs.filter((s) => t >= s.t1);
        const pending = segs.some((s) => t < s.t0);
        const holderIdx = !started.length ? tl.holderBefore : pending ? null : tl.holderAfter;
        if (tl.rest && t < tl.rest.until && started.length) {
          // Ball sits in the net while everyone celebrates.
        } else if (holderIdx != null && avatars.get(holderIdx)) {
          const want = feet(avatars.get(holderIdx), tmp);
          if (started.length && t < Math.max(...started.map((s) => s.t1)) + 220) ball.position.lerp(want, 1 - Math.exp(-dt * 14));
          else ball.position.copy(want);
        }
      }
    } else if (match) {
      const h = avatars.get(match.ballCarrier);
      if (h) ball.position.lerp(feet(h, tmp), 1 - Math.exp(-dt * 10));
    }
    // Spin the ball in the direction it's travelling.
    const d = tmp.subVectors(ball.position, before);
    const len = d.length();
    if (len > 1e-4) {
      const axis = new THREE.Vector3(d.z, 0, -d.x).normalize();
      if (axis.lengthSq() > 0) ball.rotateOnWorldAxis(axis, len / BALL_R);
    }
    const glow = { inferno: 0xff5a0a, venom: 0x22c55e, power: 0x666666 }[shotStyle] ?? 0x000000;
    ballMat.emissive.setHex(glow);
    if (shotStyle) trail(ball.position, { inferno: 0xff7a18, venom: 0x4ade80, power: 0xffffff, shoot: 0xbfdbfe }[shotStyle]);
  }

  function placeLabels() {
    const r = stage.getBoundingClientRect();
    const v = new THREE.Vector3();
    for (const av of avatars.values()) {
      v.set(av.pos.x, (av.grounded ? 1.6 : 3.55) * av.root.scale.y, av.pos.z).project(camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      av.label.style.display = vis ? '' : 'none';
      if (vis) av.label.style.transform = `translate(${((v.x + 1) / 2) * r.width}px, ${((1 - v.y) / 2) * r.height}px) translate(-50%, -100%)`;
    }
    for (const o of markerObjs) {
      v.copy(o.pos).project(camera);
      o.label.style.transform = `translate(${((v.x + 1) / 2) * r.width}px, ${((1 - v.y) / 2) * r.height}px) translate(-50%, -50%)`;
    }
  }

  // ---- loop -----------------------------------------------------------------
  let raf = 0;
  let lastFrame = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!stage.isConnected || stage.offsetParent === null) return; // hidden: skip the GPU work
    let t = null;
    if (tl) {
      t = now - tl.start;
      for (const e of tl.effects) {
        if (!e.done && t >= e.t) {
          e.done = true;
          e.fn();
        }
      }
      if (t > tl.duration) {
        for (const av of avatars.values()) {
          av.pieces = [];
          av.acts = [];
        }
        tl = null;
        t = null;
      }
    }
    if (match) {
      for (const av of avatars.values()) animateAvatar(av, t, dt, now);
      ballFrame(t, dt);
    }
    for (const [team, k] of Object.entries(keepers)) animateKeeper(team, k, dt, now);
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.age += dt;
      const u = f.age / f.life;
      if (u >= 1) {
        scene.remove(f.obj);
        if (!f.obj.isSprite) f.obj.geometry?.dispose(); // sprites share one geometry
        f.obj.material?.dispose();
        fx.splice(i, 1);
      } else {
        f.step(f.obj, u, now);
      }
    }
    let liveConf = false;
    confData.forEach((c, i) => {
      if (c.life <= 0) return;
      liveConf = true;
      c.life -= dt;
      c.v.y -= 11 * dt;
      c.v.multiplyScalar(1 - dt * 0.6);
      c.p.addScaledVector(c.v, dt);
      if (c.p.y < 0.05) {
        c.p.y = 0.05;
        c.v.set(0, 0, 0);
      }
      c.r.x += dt * 5;
      c.r.y += dt * 3;
      dummy.position.copy(c.p);
      dummy.rotation.copy(c.r);
      dummy.scale.setScalar(c.life > 0 ? 1 : 0);
      dummy.updateMatrix();
      confetti.setMatrixAt(i, dummy.matrix);
    });
    if (liveConf) confetti.instanceMatrix.needsUpdate = true;
    for (const o of markerObjs) o.ring.rotation.z += dt;
    updateCamera(dt, now);
    renderer.render(scene, camera);
    placeLabels();
  }

  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    kind: '3d',
    update,
    setCamera,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          m.map?.dispose();
          m.dispose();
        }
      });
      renderer.dispose();
      stage.remove();
    },
  };
}
