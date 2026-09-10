import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DATACENTRE_ICON, CLOUD_ICON } from "./nodeIcons.js";

/* ────────────────────────────────────────────────────────────
   Polarin — Network Topology
   Every PoP sits on an isometric lattice point. No grouping.
   Placement rules live in one place: LATTICE below.
   ──────────────────────────────────────────────────────────── */

const C = {
  navy: "#0a3954", ink: "#324158", steel: "#7e93b2", mist: "#a7aebc", pale: "#c3cdd9",
  teal: "#1c808d", tealBright: "#3696b1", sky: "#b7dde8",
  live: "#0bd05d", down: "#c20008", design: "#2f5fea",
  canvas: "#eef3f8", line: "#e2e8f1", hair: "#eef3f8",
};
const STATUS = {
  live: { label: "Live", color: C.live },
  down: { label: "Down", color: C.down },
  design: { label: "Design", color: C.design },
};
const DISPLAY = '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif';
const BODY = '"Lato", ui-sans-serif, system-ui, sans-serif';

/* ── the lattice ────────────────────────────────────────────
   A PoP's address is (u, v): u is its column on the iso grid,
   v its row. World position is u*94 across, v*47 down — the
   two isometric axes. Both are kept even so a node always
   lands on a grid vertex.

   Spacing rule: adjacent columns are already 188 px apart, so
   the only way two PoPs can crowd each other is by sharing a
   column. Within a column they must be at least 4 v-steps
   (188 px) apart. That single rule is what every placement,
   drag and tidy-up is checked against.
   ─────────────────────────────────────────────────────────── */
const UX = 94;          // world px per u step
const VY = 47;          // world px per v step
const V_CLEAR = 4;      // minimum v separation inside one column
const STEP = 2;         // lattice granularity (keeps u, v even)

const toWorld = (u, v) => ({ wx: u * UX, wy: v * VY });
const snapU = (wx) => Math.round(wx / UX / STEP) * STEP;
const snapV = (wy) => Math.round(wy / VY / STEP) * STEP;

/** is (u,v) clear of every PoP except `exceptId`? */
function slotFree(dcs, u, v, exceptId) {
  return !dcs.some((d) => d.id !== exceptId && d.u === u && Math.abs(d.v - v) < V_CLEAR);
}

/** nearest free lattice point to (u,v), searched outwards */
function nearestFreeSlot(dcs, u, v, exceptId) {
  if (slotFree(dcs, u, v, exceptId)) return { u, v };
  const cands = [];
  for (let du = -12; du <= 12; du += STEP) {
    for (let dv = -16; dv <= 16; dv += STEP) {
      if (!du && !dv) continue;
      cands.push({ u: u + du, v: v + dv, d: Math.hypot(du * UX, dv * VY) });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  const hit = cands.find((c) => slotFree(dcs, c.u, c.v, exceptId));
  return hit ? { u: hit.u, v: hit.v } : { u, v: v + V_CLEAR * STEP };
}

/** where a new PoP should land: beside a PoP in the same city,
    else the same country, else the right-hand edge of the map */
function proposeSlot(dcs, city, country) {
  const peers = dcs.filter((d) => d.city.toLowerCase() === city.trim().toLowerCase());
  const pool = peers.length ? peers : dcs.filter((d) => d.country.toLowerCase() === country.trim().toLowerCase());
  if (pool.length) {
    const a = pool[0];
    return nearestFreeSlot(dcs, a.u + STEP, a.v + STEP);
  }
  const edge = dcs.reduce((m, d) => Math.max(m, d.u), 0);
  return nearestFreeSlot(dcs, edge + STEP * 2, 0);
}

/** resolve every clash by moving the later PoP to its nearest free point */
function tidy(dcs) {
  const out = [];
  dcs.forEach((d) => {
    const u = snapU(d.u * UX), v = snapV(d.v * VY);
    const spot = nearestFreeSlot(out, u, v, d.id);
    out.push({ ...d, u: spot.u, v: spot.v });
  });
  return out;
}

/* ── render constants ────────────────────────────────────── */
const TILE_W = 188, TILE_H = 94;   // iso tile, for link routing
const PH_HW = 46, PH_HH = 23;      // platform diamond half-size

/** rounded-corner rhombus path — same 4-point diamond, with each vertex
    softened by a short quadratic curve instead of a sharp point */
function roundedDiamondPath(hw, hh, r = 7) {
  const pts = [[0, -hh], [hw, 0], [0, hh], [-hw, 0]];
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const toPrev = [prev[0] - curr[0], prev[1] - curr[1]];
    const toNext = [next[0] - curr[0], next[1] - curr[1]];
    const lenPrev = Math.hypot(...toPrev), lenNext = Math.hypot(...toNext);
    const rr = Math.min(r, lenPrev / 2, lenNext / 2);
    const p1 = [curr[0] + (toPrev[0] / lenPrev) * rr, curr[1] + (toPrev[1] / lenPrev) * rr];
    const p2 = [curr[0] + (toNext[0] / lenNext) * rr, curr[1] + (toNext[1] / lenNext) * rr];
    d += (i === 0 ? `M ${p1[0]} ${p1[1]} ` : `L ${p1[0]} ${p1[1]} `) + `Q ${curr[0]} ${curr[1]} ${p2[0]} ${p2[1]} `;
  }
  return d + "Z";
}
const PLATFORM_PATH = roundedDiamondPath(PH_HW, PH_HH, 7);
const MIN_SCALE = 0.4, MAX_SCALE = 2.8;
const LOD_CITY = 0.5;              // city labels appear
const LOD_FULL = 0.92;             // facility, provider, ports appear

/* ── catalogue + seed data ───────────────────────────────── */
const CATALOG = [
  { name: "Dedicated Internet Access", category: "Connectivity", from: "1 Gbps", lead: "5 days" },
  { name: "Cloud Direct Connect", category: "Cloud", from: "1 Gbps", lead: "7 days" },
  { name: "Elastic Cross Connect", category: "Fabric", from: "1 Gbps", lead: "48 hrs" },
  { name: "Metro Ethernet (P2P)", category: "Connectivity", from: "1 Gbps", lead: "10 days" },
  { name: "SD-WAN Edge", category: "Managed", from: "100 Mbps", lead: "3 days" },
  { name: "Colocation — Half Rack", category: "Space & Power", from: "2 kW", lead: "14 days" },
  { name: "DDoS Protection", category: "Security", from: "10 Gbps", lead: "24 hrs" },
];
const sv = (id, name, gbps, status) => ({ id, name, bandwidth: `${gbps.toFixed(1)} Gbps`, status });

const SEED = [
  { id: "dc-del-1", facility: "Sify, Lajpat Nagar", city: "Delhi", country: "India", provider: "Sify", providerColor: "#93c020", status: "live", u: -2, v: -4,
    ordered: [sv("PVRMAA0900487", "Core Uplink A", 10, "live"), sv("PVRMAA0900482", "Cloud OnRamp", 10, "live"), sv("PVRMAA0900311", "Backhaul West", 1, "design")] },
  { id: "dc-ggn-1", facility: "CtrlS Gurugram", city: "Gurugram", country: "India", provider: "CtrlS", providerColor: "#1f7ae0", status: "down", u: 0, v: -2,
    ordered: [sv("PVRMAA0900777", "Cross Connect DR", 10, "down")] },

  { id: "dc-mum-1", facility: "Jio, Turbhe", city: "Mumbai", country: "India", provider: "Jio", providerColor: "#0a3fa8", status: "live", ports: 4, u: -2, v: 0,
    ordered: [sv("PVRMAA0900120", "Internet Exchange Peer", 100, "live"), sv("PVRMAA0900121", "Subsea Landing", 100, "live")] },
  { id: "dc-mum-3", facility: "AWS ap-south-1", city: "Mumbai", country: "India", provider: "AWS", providerColor: "#ff9900", status: "live", kind: "cloud", ports: 8, u: -2, v: 4,
    ordered: [sv("PVRMAA0900135", "Direct Connect — AWS", 40, "live"), sv("PVRMAA0900136", "Cloud OnRamp — Azure", 10, "live")] },
  { id: "dc-pun-1", facility: "STT Hinjewadi", city: "Pune", country: "India", provider: "STT", providerColor: "#e8542a", status: "design", u: 0, v: 2,
    ordered: [sv("PVRMAA0900140", "Metro E-Line", 1, "design")] },

  { id: "dc-che-1", facility: "NTT Ambattur", city: "Chennai", country: "India", provider: "NTT", providerColor: "#0071c5", status: "live", ports: 6, u: 4, v: 4,
    ordered: [sv("PVRMAA0900487", "VR PayG", 10, "live"), sv("PVRMAA0900482", "Cross Connect", 10, "live")] },

  { id: "dc-sin-2", facility: "AWS ap-southeast-1", city: "Singapore", country: "Singapore", provider: "AWS", providerColor: "#ff9900", status: "live", kind: "cloud", ports: 8, u: 6, v: 2,
    ordered: [sv("PVRMAA0900801", "Cloud OnRamp — AWS", 40, "live"), sv("PVRMAA0900800", "Global Transit", 100, "live")] },
].map((d) => ({ ...d, available: CATALOG }));

const SEED_LINKS = [
  { from: "dc-del-1", to: "dc-ggn-1", status: "down", gbps: 10, latencyMs: 213.98 },
  { from: "dc-del-1", to: "dc-mum-1", status: "live", gbps: 100 },
  { from: "dc-del-1", to: "dc-che-1", status: "live", gbps: 40 },
  { from: "dc-mum-1", to: "dc-mum-3", status: "live", gbps: 100 },
  { from: "dc-mum-1", to: "dc-pun-1", status: "design", gbps: 10 },
  { from: "dc-mum-1", to: "dc-che-1", status: "live", gbps: 100 },
  { from: "dc-che-1", to: "dc-sin-2", status: "live", gbps: 100 },
];

/* ── link routing along the two iso axes ─────────────────── */
function isoRoute(x1, y1, x2, y2, r = 26) {
  const dx = x2 - x1, dy = y2 - y1;
  const ux = TILE_W / 2, uy = TILE_H / 2, vx = -TILE_W / 2, vy = TILE_H / 2;
  const det = ux * vy - vx * uy;
  const a = (dx * vy - vx * dy) / det;
  const b = (ux * dy - dx * uy) / det;
  const [ex, ey] = Math.abs(a) >= Math.abs(b) ? [x1 + a * ux, y1 + a * uy] : [x1 + b * vx, y1 + b * vy];
  const v1x = ex - x1, v1y = ey - y1, l1 = Math.hypot(v1x, v1y) || 1;
  const v2x = x2 - ex, v2y = y2 - ey, l2 = Math.hypot(v2x, v2y) || 1;
  const rr = Math.min(r, l1 / 2, l2 / 2);
  const d = `M ${x1} ${y1} L ${ex - (v1x / l1) * rr} ${ey - (v1y / l1) * rr}` +
    ` Q ${ex} ${ey} ${ex + (v2x / l2) * rr} ${ey + (v2y / l2) * rr} L ${x2} ${y2}`;
  return { d, ex, ey };
}
const linkId = (l) => `${l.from}|${l.to}`;

/* ── glyphs ──────────────────────────────────────────────── */
function Icon({ path, size = 20, w = 1.9 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={w} strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
  );
}

function RackGlyph() {
  return <image href={DATACENTRE_ICON} x={-36} y={-53} width={72} height={72} preserveAspectRatio="xMidYMid meet" />;
}

/* seated on its platform — underside just clears the tile */
function CloudGlyph() {
  return <image href={CLOUD_ICON} x={-38} y={-50} width={76} height={76} preserveAspectRatio="xMidYMid meet" />;
}

/* ── the map ─────────────────────────────────────────────── */
function IsometricMap({
  datacenters, links, filters, selectedId, selectedLinkId, onSelect, onSelectLink, onPlace,
  svgRef, controlsRef, onView, insetLeft, insetRight,
}) {
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [view, setView] = useState({ scale: 1, tx: 600, ty: 400 });
  const [hover, setHover] = useState(null);
  const [hoverLink, setHoverLink] = useState(null);
  const [ptr, setPtr] = useState({ x: 0, y: 0 });
  const [snap, setSnap] = useState(null);   // { id, u, v, valid } while dragging a PoP
  const wrapRef = useRef(null);
  const pan = useRef(null);
  const nodeDrag = useRef(null);
  const [panning, setPanning] = useState(false);

  const nodes = useMemo(
    () => datacenters.filter((d) => filters[d.status]).map((d) => ({ dc: d, ...toWorld(d.u, d.v) })),
    [datacenters, filters]
  );
  const nodeById = useMemo(() => {
    const m = new Map();
    nodes.forEach((n) => m.set(n.dc.id, n));
    return m;
  }, [nodes]);

  const centre = useCallback((scale) => {
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.wx), ys = nodes.map((n) => n.wy);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    // weight each PoP by how much it carries, then blend with the plain
    // bounding-box centre so the busiest sit mid-frame without pushing
    // the outliers off the edge
    let wsum = 0, wx = 0, wy = 0;
    nodes.forEach((n) => {
      const k = 1 + n.dc.ordered.length + (n.dc.status === "live" ? 1 : 0);
      wsum += k; wx += n.wx * k; wy += n.wy * k;
    });
    const BIAS = 0.6;
    let cx = (wx / wsum) * BIAS + ((minX + maxX) / 2) * (1 - BIAS);
    let cy = (wy / wsum) * BIAS + ((minY + maxY) / 2) * (1 - BIAS) - 8;

    const availL = insetLeft + 40, availR = size.w - insetRight - 40;
    const availCx = (availL + availR) / 2, availW = availR - availL;
    const availCy = size.h / 2, availH = size.h - 130;

    // if the whole topology fits, pull the centre back so nothing falls outside
    const padX = 150, padY = 120;
    const spanW = (maxX - minX) * scale + padX * 2;
    const spanH = (maxY - minY) * scale + padY * 2;
    if (spanW <= availW) {
      const lo = maxX - (availW / 2 - padX) / scale, hi = minX + (availW / 2 - padX) / scale;
      cx = Math.min(Math.max(cx, Math.min(lo, hi)), Math.max(lo, hi));
    } else cx = Math.min(Math.max(cx, minX), maxX);
    if (spanH <= availH) {
      const lo = maxY - (availH / 2 - padY) / scale, hi = minY + (availH / 2 - padY) / scale;
      cy = Math.min(Math.max(cy, Math.min(lo, hi)), Math.max(lo, hi));
    } else cy = Math.min(Math.max(cy, minY), maxY);

    setView({ scale, tx: availCx - cx * scale, ty: availCy - cy * scale });
  }, [nodes, size, insetLeft, insetRight]);

  /** default view: 100%, centred, every detail on */
  const home = useCallback(() => centre(1), [centre]);

  const fit = useCallback(() => {
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.wx), ys = nodes.map((n) => n.wy);
    const box = { x: Math.min(...xs) - 150, y: Math.min(...ys) - 120, w: 0, h: 0 };
    box.w = Math.max(...xs) + 150 - box.x;
    box.h = Math.max(...ys) + 110 - box.y;
    const availW = Math.max(260, size.w - insetLeft - insetRight - 60);
    const availH = Math.max(200, size.h - 90);
    const scale = Math.max(MIN_SCALE, Math.min(availW / box.w, availH / box.h, 1.7));
    setView({
      scale,
      tx: insetLeft + 30 + availW / 2 - (box.x + box.w / 2) * scale,
      ty: 45 + availH / 2 - (box.y + box.h / 2) * scale,
    });
  }, [nodes, size, insetLeft, insetRight]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const didFit = useRef(false);
  useEffect(() => {
    if (!didFit.current && size.w > 100 && nodes.length) { home(); didFit.current = true; }
  }, [size, nodes, home]);

  useEffect(() => { onView?.(view.scale, nodes.length); }, [view.scale, nodes.length, onView]);

  const zoomAbout = useCallback((factor, cx, cy) => {
    setView((v) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  }, []);

  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      zoomIn: () => zoomAbout(1.25, size.w / 2, size.h / 2),
      zoomOut: () => zoomAbout(1 / 1.25, size.w / 2, size.h / 2),
      fit,
      home,
      centreOn: (id) => {
        const n = nodeById.get(id);
        if (!n) return;
        setView((v) => ({
          ...v,
          tx: insetLeft + (size.w - insetLeft - insetRight) / 2 - n.wx * v.scale,
          ty: size.h / 2 - n.wy * v.scale,
        }));
      },
    };
  }, [controlsRef, zoomAbout, fit, home, nodeById, size, insetLeft, insetRight]);

  const onWheel = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    zoomAbout(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  };
  const onCanvasDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };
  const onNodeDown = (e, n) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    nodeDrag.current = { id: n.dc.id, x: e.clientX, y: e.clientY, u: n.dc.u, v: n.dc.v, moved: false };
    setSnap({ id: n.dc.id, u: n.dc.u, v: n.dc.v, valid: true });
  };
  const onMove = (e) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setPtr({ x: e.clientX - r.left, y: e.clientY - r.top });
    const nd = nodeDrag.current;
    if (nd) {
      const dx = (e.clientX - nd.x) / view.scale, dy = (e.clientY - nd.y) / view.scale;
      if (!nd.moved && Math.hypot(e.clientX - nd.x, e.clientY - nd.y) > 4) nd.moved = true;
      const u = snapU(nd.u * UX + dx), v = snapV(nd.v * VY + dy);
      setSnap({ id: nd.id, u, v, valid: slotFree(datacenters, u, v, nd.id) });
      return;
    }
    const base = pan.current;
    if (!base) return;
    const dx = e.clientX - base.x, dy = e.clientY - base.y;
    if (!panning && Math.hypot(dx, dy) > 3) setPanning(true);
    setView((v) => ({ ...v, tx: base.tx + dx, ty: base.ty + dy }));
  };
  const onUp = () => {
    const nd = nodeDrag.current;
    if (nd) {
      nodeDrag.current = null;
      const s = snap;
      setSnap(null);
      if (nd.moved && s) onPlace(nd.id, s.u, s.v);
      else if (!nd.moved) {
        const dc = datacenters.find((d) => d.id === nd.id);
        if (dc) onSelect(dc);
      }
      return;
    }
    pan.current = null;
    setTimeout(() => setPanning(false), 0);
  };

  const s = view.scale;
  const px = (v) => v / s;   // world units that render as v screen pixels
  const full = s >= LOD_FULL;
  const cityOnly = s >= LOD_CITY && !full;

  const lit = useMemo(() => {
    if (!selectedId) return null;
    return new Set(links.filter((l) => l.from === selectedId || l.to === selectedId).map(linkId));
  }, [selectedId, links]);

  const hoverTip = useMemo(() => {
    if (!hoverLink || snap) return null;
    const l = links.find((x) => linkId(x) === hoverLink);
    if (!l) return null;
    const a = nodeById.get(l.from), b = nodeById.get(l.to);
    return a && b ? { l, a, b } : null;
  }, [hoverLink, snap, links, nodeById]);

  /* candidate lattice points, shown only while a PoP is in hand */  const slots = useMemo(() => {
    if (!snap) return [];
    const out = [];
    for (let du = -6; du <= 6; du += STEP) {
      for (let dv = -8; dv <= 8; dv += STEP) {
        const u = snap.u + du, v = snap.v + dv;
        out.push({ u, v, ...toWorld(u, v), ok: slotFree(datacenters, u, v, snap.id) });
      }
    }
    return out;
  }, [snap, datacenters]);

  const dragTarget = snap ? toWorld(snap.u, snap.v) : null;

  return (
    <div ref={wrapRef} onWheel={onWheel} onPointerDown={onCanvasDown} onPointerMove={onMove}
      onPointerUp={onUp} onPointerLeave={onUp}
      style={{
        position: "relative", height: "100%", width: "100%", overflow: "hidden",
        cursor: snap ? "grabbing" : panning ? "grabbing" : "grab", touchAction: "none",
        background: "radial-gradient(130% 100% at 42% 4%, #ffffff 0%, #f2f7fc 46%, #e3ebf4 100%)",
      }}>
      <svg ref={svgRef} width={size.w} height={size.h} style={{ display: "block", userSelect: "none" }}>
        <defs>
          {/* fine grid: one cell is 47 x 23.5, so a PoP's pitch is 4 x 4 cells */}
          <pattern id="isoGrid" width={47 * s} height={23.5 * s} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.tx - 23.5 * s} ${view.ty})`}>
            <path d={`M ${23.5 * s} 0 L ${47 * s} ${11.75 * s} L ${23.5 * s} ${23.5 * s} L 0 ${11.75 * s} Z`} fill="none" stroke="#c6d3e0" strokeWidth="1" opacity="0.3" />
          </pattern>
          <radialGradient id="cloudGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="55%" stopColor="#eaf3fb" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#eaf3fb" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="rackTop" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f7fbfe" /><stop offset="100%" stopColor="#dcebf6" />
          </linearGradient>
          <linearGradient id="tealPill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={C.tealBright} /><stop offset="100%" stopColor="#227a93" />
          </linearGradient>
          <filter id="nodeShadow" x="-60%" y="-60%" width="220%" height="240%">
            <feDropShadow dx="0" dy="9" stdDeviation="7" floodColor={C.navy} floodOpacity="0.16" />
          </filter>
          <filter id="chipShadow" x="-40%" y="-40%" width="180%" height="200%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor={C.navy} floodOpacity="0.14" />
          </filter>
          <filter id="linkGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        </defs>

        <rect width={size.w} height={size.h} fill="url(#isoGrid)" />

        <g transform={`translate(${view.tx} ${view.ty}) scale(${s})`}>
          {/* free / blocked lattice points, only while dragging */}
          {snap && slots.map((p) => (
            <polygon key={`${p.u},${p.v}`}
              points={`0,${-23.5} 47,0 0,${23.5} -47,0`}
              transform={`translate(${p.wx} ${p.wy})`}
              fill={p.ok ? C.teal : C.down} opacity={p.ok ? 0.22 : 0.16} />
          ))}
          {snap && dragTarget && (
            <polygon points="0,-47 94,0 0,47 -94,0"
              transform={`translate(${dragTarget.wx} ${dragTarget.wy})`}
              fill={snap.valid ? `${C.teal}1a` : `${C.down}1a`}
              stroke={snap.valid ? C.teal : C.down} strokeWidth="2.4" strokeDasharray="8 6" />
          )}

          {/* links — hoverable and clickable. widths are held in screen px so
              they stay hairline-thin whatever the zoom */}
          {links.map((l) => {
            const a = nodeById.get(l.from), b = nodeById.get(l.to);
            if (!a || !b) return null;
            const id = linkId(l);
            const meta = STATUS[l.status];
            const { d } = isoRoute(a.wx, a.wy, b.wx, b.wy, 26);
            const isHov = hoverLink === id;
            const isSel = selectedLinkId === id;
            const on = (!lit || lit.has(id)) && (!selectedLinkId || isSel);
            const base = 1.3 + Math.min(1.3, l.gbps / 80);          // 10G → 1.4px, 100G → 2.6px
            const w = px(isHov || isSel ? base + 1.1 : base);
            return (
              <g key={id} opacity={on ? 1 : 0.13}>
                {(isHov || isSel) && (
                  <path d={d} fill="none" stroke="#ffffff" strokeWidth={w + px(5)} strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
                )}
                <path d={d} fill="none" stroke={meta.color} strokeOpacity={isHov || isSel ? 0.5 : 0.3} strokeWidth={w + px(1.8)}
                  strokeLinecap="round" strokeLinejoin="round" filter="url(#linkGlow)" />
                <path d={d} fill="none" stroke={meta.color} strokeOpacity={l.status === "design" ? 0.75 : 1} strokeWidth={w}
                  strokeLinecap="round" strokeLinejoin="round" strokeDasharray={l.status === "design" ? `${px(8)} ${px(6)}` : undefined} />
                {l.status === "live" && on && (
                  <circle r={px(isHov || isSel ? 3.2 : 2.4)} fill="#ffffff" stroke={meta.color} strokeWidth={px(1.2)}>
                    <animateMotion dur={`${Math.max(2.6, 7.5 - l.gbps / 22)}s`} repeatCount="indefinite" path={d} />
                  </circle>
                )}
                {/* invisible hit band — wide enough to grab, still lets the canvas pan */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={px(18)}
                  strokeLinecap="round" strokeLinejoin="round"
                  style={{ cursor: "pointer", pointerEvents: "stroke" }}
                  onPointerEnter={() => setHoverLink(id)}
                  onPointerLeave={() => setHoverLink((h) => (h === id ? null : h))}
                  onClick={() => { if (!panning && !snap) onSelectLink(l); }} />
              </g>
            );
          })}

          {/* PoPs, painted back to front */}
          {[...nodes].sort((a, b) => a.wy - b.wy || a.wx - b.wx).map((n) => {
            const dc = n.dc;
            const held = snap?.id === dc.id;
            const pos = held && dragTarget ? dragTarget : n;
            const isSel = dc.id === selectedId;
            const isHov = dc.id === hover;
            const isCloud = dc.kind === "cloud";
            const chipW = Math.max(46, dc.provider.length * 6 + 20);
            const edge = held ? (snap.valid ? C.teal : C.down) : isSel ? C.teal : isHov ? C.tealBright : C.sky;

            return (
              <g key={dc.id} transform={`translate(${pos.wx} ${pos.wy})`}
                onPointerDown={(e) => onNodeDown(e, n)}
                onPointerEnter={() => setHover(dc.id)}
                onPointerLeave={() => setHover((h) => (h === dc.id ? null : h))}
                style={{ cursor: held ? "grabbing" : "pointer", transition: held ? "none" : "transform 260ms cubic-bezier(0.22,0.61,0.36,1)" }}>
                <ellipse cx="0" cy={-22} rx="72" ry="60" fill="url(#cloudGlow)" />
                <ellipse cx="0" cy={PH_HH * 0.55} rx={PH_HW * 0.95} ry={PH_HH * 0.5} fill={C.navy} opacity={isHov || isSel || held ? 0.22 : 0.13} />

                <path d={PLATFORM_PATH} fill="#ffffff"
                  stroke={edge} strokeWidth={isSel || held ? 2.4 : 1.25} strokeLinejoin="round" />
                <path d={PLATFORM_PATH} fill="url(#cloudGlow)" opacity="0.5" />

                <g filter="url(#nodeShadow)">{isCloud ? <CloudGlyph /> : <RackGlyph />}</g>

                {full && !isCloud && (
                  <g transform="translate(23 11.5) rotate(26.565)">
                    <rect x="-27" y="-9" width="54" height="18" rx="9" fill="url(#tealPill)" filter="url(#chipShadow)" />
                    <text x="0" y="4" textAnchor="middle" fill="#fff" fontFamily={BODY} fontWeight="700" fontSize="10.5">{dc.ports ?? 2} ports</text>
                  </g>
                )}
                {full && (
                  <g transform="translate(0 -61)">
                    <rect x={-chipW / 2} y="-13" width={chipW} height="26" rx="8" fill="#ffffff" filter="url(#chipShadow)" />
                    <text x="0" y="4" textAnchor="middle" fill={dc.providerColor} fontFamily={DISPLAY} fontWeight="800" fontSize="11.5">{dc.provider}</text>
                  </g>
                )}

                {(full || isHov || isSel) && (
                  <g transform={`translate(0 ${PH_HH + 12}) scale(${1 / s})`} style={{ pointerEvents: "none" }}>
                    <text x="0" y="13" textAnchor="middle" fill={C.navy} fontFamily={DISPLAY} fontWeight="600" fontSize="12.5"
                      stroke="#ffffff" strokeWidth="3.4" paintOrder="stroke">{dc.facility}</text>
                    <text x="0" y="28" textAnchor="middle" fill={C.steel} fontFamily={BODY} fontSize="11.5"
                      stroke="#ffffff" strokeWidth="3" paintOrder="stroke">{dc.city}</text>
                  </g>
                )}
                {cityOnly && !isHov && !isSel && (
                  <g transform={`translate(0 ${PH_HH + 12}) scale(${1 / s})`} style={{ pointerEvents: "none" }}>
                    <text x="0" y="13" textAnchor="middle" fill={C.ink} fontFamily={DISPLAY} fontWeight="600" fontSize="11.5"
                      stroke="#ffffff" strokeWidth="3.2" paintOrder="stroke">{dc.city}</text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {hoverTip && (
        <div style={{
          position: "absolute", zIndex: 12, pointerEvents: "none",
          left: Math.min(ptr.x + 16, Math.max(8, size.w - 236)),
          top: Math.max(8, ptr.y - 56),
          width: 220, borderRadius: 12, background: "#ffffff",
          border: `1px solid ${C.line}`, boxShadow: "0 10px 26px rgba(10,57,84,0.18)",
          padding: "10px 13px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: STATUS[hoverTip.l.status].color, flexShrink: 0 }} />
            <span style={{ fontFamily: DISPLAY, fontSize: 13.5, fontWeight: 700, color: C.navy }}>
              {hoverTip.l.gbps} Gbps · {STATUS[hoverTip.l.status].label}
            </span>
          </div>
          <p style={{ margin: "3px 0 0", fontFamily: BODY, fontSize: 12, color: C.steel, lineHeight: 1.4 }}>
            {hoverTip.a.dc.city} — {hoverTip.b.dc.city}
          </p>
          {hoverTip.l.latencyMs != null && (
            <p style={{ margin: "3px 0 0", fontFamily: BODY, fontSize: 12, color: C.down }}>
              {hoverTip.l.latencyMs.toFixed(2)} ms round trip
            </p>
          )}
          <p style={{ margin: "6px 0 0", fontFamily: BODY, fontSize: 11, color: C.mist }}>Click for details</p>
        </div>
      )}

      {snap && (
        <div style={{
          position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)",
          borderRadius: 999, background: snap.valid ? "rgba(10,57,84,0.88)" : "rgba(194,0,8,0.9)",
          color: "#fff", padding: "6px 16px", fontFamily: BODY, fontSize: 12.5, whiteSpace: "nowrap", pointerEvents: "none",
        }}>
          {snap.valid
            ? `Grid ${snap.u}, ${snap.v} — free. Release to place.`
            : `Grid ${snap.u}, ${snap.v} — needs four cells of clearance in this column.`}
        </div>
      )}
      {!full && !snap && (
        <div style={{
          position: "absolute", bottom: 76, left: "50%", transform: "translateX(-50%)",
          borderRadius: 999, background: "rgba(10,57,84,0.8)", color: "#fff", padding: "5px 14px",
          fontFamily: BODY, fontSize: 12, whiteSpace: "nowrap", pointerEvents: "none",
        }}>Zoom in for facility names, providers and ports</div>
      )}
    </div>
  );
}

/* ── shared button reset ─────────────────────────────────── */
const btnBare = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  border: "none", background: "none", cursor: "pointer", font: "inherit", padding: 0,
};

/* ── service side panel ──────────────────────────────────── */
function ServicePanel({ dc, onClose }) {
  const [tab, setTab] = useState("ordered");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  useEffect(() => { setTab("ordered"); setQuery(""); setStatusFilter("all"); }, [dc.id]);

  const counts = useMemo(() => {
    const c = { all: dc.ordered.length, live: 0, down: 0, design: 0 };
    dc.ordered.forEach((s) => (c[s.status] += 1));
    return c;
  }, [dc]);

  const q = query.toLowerCase();
  const ordered = dc.ordered.filter((s) =>
    (statusFilter === "all" || s.status === statusFilter) &&
    (s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)));
  const available = dc.available.filter((s) => s.name.toLowerCase().includes(q));

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", flexDirection: "column", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.hair}`, padding: "20px 24px" }}>
        <div style={{ display: "flex", width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 12, color: "#fff", background: dc.providerColor, fontFamily: DISPLAY, fontWeight: 700, fontSize: 15 }}>
          {dc.provider.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontFamily: DISPLAY, fontSize: 19, fontWeight: 700, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dc.facility}</h2>
          <p style={{ margin: 0, fontFamily: BODY, fontSize: 13, color: C.steel }}>{dc.city}, {dc.country} · grid {dc.u}, {dc.v}</p>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ ...btnBare, width: 36, height: 36, borderRadius: 8, color: C.steel }}>
          <Icon path="M6 6l12 12M18 6L6 18" size={18} w={2.2} />
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, padding: "16px 24px 0" }}>
        {[["ordered", "Ordered services"], ["available", "Available to order"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...btnBare, borderRadius: 8, padding: "8px 14px", fontFamily: DISPLAY, fontSize: 14, fontWeight: 600,
            background: tab === k ? "#eaf6f9" : "transparent", color: tab === k ? C.navy : C.steel }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "16px 24px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderRadius: 12, border: `1px solid ${C.line}`, background: "#f8fafb", padding: "10px 14px" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={C.steel} strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" /></svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "ordered" ? "Search by service name or service ID" : "Search the catalogue"}
            style={{ width: "100%", background: "transparent", border: "none", outline: "none", fontFamily: BODY, fontSize: 14, color: C.navy }} />
        </div>
      </div>

      {tab === "ordered" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "16px 24px 0" }}>
          {["all", "live", "down", "design"].map((k) => {
            const active = statusFilter === k;
            return (
              <button key={k} onClick={() => setStatusFilter(k)} style={{
                ...btnBare, gap: 6, borderRadius: 999, padding: "6px 12px", fontFamily: BODY, fontSize: 13, fontWeight: 500,
                background: active ? C.teal : "#fff", color: active ? "#fff" : C.ink,
                border: active ? "1px solid transparent" : `1px solid ${C.line}` }}>
                {k === "all" ? "All" : STATUS[k].label}
                <span style={{ color: active ? "rgba(255,255,255,0.8)" : C.mist }}>{counts[k]}</span>
              </button>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 16, flex: 1, overflowY: "auto", padding: "0 24px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        {tab === "ordered" && ordered.map((s) => {
          const meta = STATUS[s.status];
          return (
            <div key={s.id} style={{ borderRadius: 16, border: `1px solid ${C.hair}`, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 12, border: `1px solid ${C.hair}`, background: "#f8fafb", color: C.tealBright }}>
                    <Icon path="M4 7h16M4 12h16M4 17h16" size={20} w={1.8} />
                  </div>
                  <div>
                    <p style={{ margin: 0, fontFamily: DISPLAY, fontSize: 15, fontWeight: 600, color: C.navy }}>{s.name}</p>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ borderRadius: 6, background: "#eaf6f9", padding: "2px 8px", fontFamily: BODY, fontSize: 12, fontWeight: 500, color: C.teal }}>{s.bandwidth}</span>
                      <span style={{ fontFamily: BODY, fontSize: 12, color: C.steel }}>{s.id}</span>
                    </div>
                  </div>
                </div>
                <span style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: 999, border: `1px solid ${meta.color}55`, padding: "4px 10px", fontFamily: BODY, fontSize: 12, fontWeight: 500, color: meta.color, whiteSpace: "nowrap" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: meta.color }} />{meta.label}
                </span>
              </div>
            </div>
          );
        })}
        {tab === "ordered" && !ordered.length && (
          <p style={{ paddingTop: 40, textAlign: "center", fontFamily: BODY, fontSize: 14, color: C.mist }}>
            Nothing here yet. Clear the filters, or order a service from the catalogue.
          </p>
        )}
        {tab === "available" && available.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderRadius: 16, border: `1px solid ${C.hair}`, padding: 16 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <p style={{ margin: 0, fontFamily: DISPLAY, fontSize: 15, fontWeight: 600, color: C.navy }}>{s.name}</p>
                <span style={{ borderRadius: 6, background: "#f3f7fb", padding: "2px 8px", fontFamily: BODY, fontSize: 11, fontWeight: 500, color: C.steel }}>{s.category}</span>
              </div>
              <p style={{ margin: "6px 0 0", fontFamily: BODY, fontSize: 12, color: C.steel }}>
                From <b style={{ color: C.ink }}>{s.from}</b> · live in {s.lead}
              </p>
            </div>
            <button style={{ ...btnBare, borderRadius: 8, background: C.teal, padding: "8px 16px", fontFamily: DISPLAY, fontSize: 13, fontWeight: 600, color: "#fff" }}>Order</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── link detail panel ───────────────────────────────────── */
function LinkPanel({ link, aEnd, bEnd, onClose, onOpenEnd }) {
  const meta = STATUS[link.status];
  const ref = `LNK-${link.from.replace(/[^0-9a-z]/gi, "").slice(-4).toUpperCase()}${link.to.replace(/[^0-9a-z]/gi, "").slice(-4).toUpperCase()}`;
  const row = (k, v, color) => (
    <div key={k} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "11px 0", borderBottom: `1px solid ${C.hair}` }}>
      <span style={{ fontFamily: BODY, fontSize: 13, color: C.steel }}>{k}</span>
      <span style={{ fontFamily: DISPLAY, fontSize: 14, fontWeight: 600, color: color ?? C.navy, textAlign: "right" }}>{v}</span>
    </div>
  );

  const endCard = (dc, label) => (
    <button onClick={() => onOpenEnd(dc.id)} style={{
      ...btnBare, width: "100%", gap: 12, justifyContent: "flex-start", textAlign: "left",
      borderRadius: 14, border: `1px solid ${C.hair}`, padding: 14 }}>
      <span style={{ display: "flex", width: 38, height: 38, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 10, background: dc.providerColor, color: "#fff", fontFamily: DISPLAY, fontSize: 13, fontWeight: 700 }}>
        {dc.provider.slice(0, 2).toUpperCase()}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: BODY, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.mist }}>{label}</span>
        <span style={{ display: "block", fontFamily: DISPLAY, fontSize: 14.5, fontWeight: 600, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dc.facility}</span>
        <span style={{ display: "block", fontFamily: BODY, fontSize: 12, color: C.steel }}>{dc.city} · grid {dc.u}, {dc.v}</span>
      </span>
      <span style={{ color: C.pale }}><Icon path="M9 6l6 6-6 6" size={16} /></span>
    </button>
  );

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", flexDirection: "column", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.hair}`, padding: "20px 24px" }}>
        <div style={{ display: "flex", width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 12, background: `${meta.color}18`, color: meta.color }}>
          <Icon path="M5 12h14M5 12l4-4M19 12l-4 4" size={22} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontFamily: DISPLAY, fontSize: 18, fontWeight: 700, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {aEnd.city} — {bEnd.city}
          </h2>
          <p style={{ margin: 0, fontFamily: BODY, fontSize: 13, color: C.steel }}>{ref}</p>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ ...btnBare, width: 36, height: 36, borderRadius: 8, color: C.steel }}>
          <Icon path="M6 6l12 12M18 6L6 18" size={18} w={2.2} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        {endCard(aEnd, "A-end")}
        {endCard(bEnd, "B-end")}

        <div>
          {row("Capacity", `${link.gbps} Gbps`)}
          {row("Status", meta.label, meta.color)}
          {link.latencyMs != null && row("Round-trip latency", `${link.latencyMs.toFixed(2)} ms`, C.down)}
          {row("Routing", "Single-elbow, on grid axes")}
          {row("Protection", link.status === "live" ? "Primary path" : "Not yet provisioned")}
        </div>

        {link.status === "down" && (
          <div style={{ borderRadius: 14, background: "#fdf3f3", border: "1px solid #f6d5d6", padding: 14 }}>
            <p style={{ margin: 0, fontFamily: DISPLAY, fontSize: 14, fontWeight: 600, color: C.down }}>This path is down</p>
            <p style={{ margin: "4px 0 0", fontFamily: BODY, fontSize: 12.5, lineHeight: 1.5, color: C.ink }}>
              Latency is well past the service threshold. Raise a ticket with both ends attached, or fail traffic over to the secondary path.
            </p>
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button style={{ ...btnBare, flex: 1, borderRadius: 10, background: C.teal, padding: "10px 14px", fontFamily: DISPLAY, fontSize: 13.5, fontWeight: 600, color: "#fff" }}>
            View performance
          </button>
          <button style={{ ...btnBare, flex: 1, borderRadius: 10, border: `1px solid ${C.line}`, background: "#fff", padding: "10px 14px", fontFamily: DISPLAY, fontSize: 13.5, fontWeight: 600, color: C.ink }}>
            Raise a ticket
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── export: a clean standalone scene ────────────────────────
   Rendered separately from the live map so nothing from the
   dashboard chrome leaks into the file. Flat grid background,
   no corner gradient, only the details that are switched on.
   ─────────────────────────────────────────────────────────── */
const EXP_W = 1600, EXP_H = 900;

const DEFAULT_EXPORT_OPTS = {
  grid: true, title: true, links: true, capacity: true,
  facility: true, city: true, provider: true, ports: true,
  status: { live: true, down: true, design: true },
};

function ExportScene({ datacenters, links, opts, sceneRef }) {
  const shown = datacenters.filter((d) => opts.status[d.status]);
  const nodes = shown.map((d) => ({ dc: d, ...toWorld(d.u, d.v) }));
  const byId = new Map(nodes.map((n) => [n.dc.id, n]));
  const titleH = opts.title ? 88 : 0;

  let s = 1, tx = EXP_W / 2, ty = titleH + (EXP_H - titleH) / 2;
  if (nodes.length) {
    const xs = nodes.map((n) => n.wx), ys = nodes.map((n) => n.wy);
    const bw = Math.max(...xs) - Math.min(...xs) + 340;
    const bh = Math.max(...ys) - Math.min(...ys) + 280;
    s = Math.min((EXP_W - 60) / bw, (EXP_H - titleH - 50) / bh, 1.5);
    tx = EXP_W / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * s;
    ty = titleH + (EXP_H - titleH) / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * s;
  }
  const px = (v) => v / s;
  const live = shown.filter((d) => d.status === "live").length;
  const services = shown.reduce((a, d) => a + d.ordered.length, 0);

  return (
    <svg ref={sceneRef} viewBox={`0 0 ${EXP_W} ${EXP_H}`} width="100%"
      xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
      <defs>
        <pattern id="xGrid" width={47 * s} height={23.5 * s} patternUnits="userSpaceOnUse" patternTransform={`translate(${tx - 23.5 * s} ${ty})`}>
          <path d={`M ${23.5 * s} 0 L ${47 * s} ${11.75 * s} L ${23.5 * s} ${23.5 * s} L 0 ${11.75 * s} Z`} fill="none" stroke="#c6d3e0" strokeWidth="1" opacity="0.34" />
        </pattern>
        <linearGradient id="rackTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f7fbfe" /><stop offset="100%" stopColor="#dcebf6" />
        </linearGradient>
        <linearGradient id="xPill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={C.tealBright} /><stop offset="100%" stopColor="#227a93" />
        </linearGradient>
        <filter id="xShadow" x="-60%" y="-60%" width="220%" height="240%">
          <feDropShadow dx="0" dy="9" stdDeviation="7" floodColor={C.navy} floodOpacity="0.15" />
        </filter>
      </defs>

      {/* flat background, no gradient */}
      <rect width={EXP_W} height={EXP_H} fill="#f4f8fc" />
      {opts.grid && <rect y={titleH} width={EXP_W} height={EXP_H - titleH} fill="url(#xGrid)" />}

      {opts.title && (
        <g>
          <rect width={EXP_W} height={titleH} fill={C.navy} />
          <text x="44" y="40" fill="#ffffff" fontFamily={DISPLAY} fontWeight="700" fontSize="25">Polarin — network topology</text>
          <text x="44" y="66" fill={C.sky} fontFamily={BODY} fontSize="14">
            {shown.length} PoPs · {live} live · {services} services · {new Date().toLocaleDateString()}
          </text>
        </g>
      )}

      <g transform={`translate(${tx} ${ty}) scale(${s})`}>
        {opts.links && links.map((l) => {
          const a = byId.get(l.from), b = byId.get(l.to);
          if (!a || !b) return null;
          const meta = STATUS[l.status];
          const { d, ex, ey } = isoRoute(a.wx, a.wy, b.wx, b.wy, 26);
          const w = px(1.3 + Math.min(1.3, l.gbps / 80));
          return (
            <g key={linkId(l)}>
              <path d={d} fill="none" stroke={meta.color} strokeOpacity="0.28" strokeWidth={w + px(2)} strokeLinecap="round" strokeLinejoin="round" />
              <path d={d} fill="none" stroke={meta.color} strokeOpacity={l.status === "design" ? 0.75 : 1} strokeWidth={w}
                strokeLinecap="round" strokeLinejoin="round" strokeDasharray={l.status === "design" ? `${px(8)} ${px(6)}` : undefined} />
              {opts.capacity && (
                <g transform={`translate(${ex} ${ey}) scale(${1 / s})`}>
                  <rect x="-30" y="-11" width="60" height="21" rx="7" fill="#ffffff" stroke={C.line} />
                  <text x="0" y="4" textAnchor="middle" fill={C.ink} fontFamily={DISPLAY} fontWeight="600" fontSize="11.5">{l.gbps} Gbps</text>
                </g>
              )}
            </g>
          );
        })}

        {[...nodes].sort((a, b) => a.wy - b.wy || a.wx - b.wx).map((n) => {
          const dc = n.dc;
          const isCloud = dc.kind === "cloud";
          const chipW = Math.max(46, dc.provider.length * 6 + 20);
          return (
            <g key={dc.id} transform={`translate(${n.wx} ${n.wy})`}>
              <ellipse cx="0" cy={PH_HH * 0.55} rx={PH_HW * 0.95} ry={PH_HH * 0.5} fill={C.navy} opacity="0.12" />
              <path d={PLATFORM_PATH} fill="#ffffff" stroke={C.sky} strokeWidth="1.25" strokeLinejoin="round" />
              <g filter="url(#xShadow)">{isCloud ? <CloudGlyph /> : <RackGlyph />}</g>

              {opts.ports && !isCloud && (
                <g transform="translate(23 11.5) rotate(26.565)">
                  <rect x="-27" y="-9" width="54" height="18" rx="9" fill="url(#xPill)" />
                  <text y="4" textAnchor="middle" fill="#fff" fontFamily={BODY} fontWeight="700" fontSize="10.5">{dc.ports ?? 2} ports</text>
                </g>
              )}
              {opts.provider && (
                <g transform="translate(0 -61)">
                  <rect x={-chipW / 2} y="-13" width={chipW} height="26" rx="8" fill="#ffffff" stroke={C.hair} />
                  <text y="4" textAnchor="middle" fill={dc.providerColor} fontFamily={DISPLAY} fontWeight="800" fontSize="11.5">{dc.provider}</text>
                </g>
              )}
              {(opts.facility || opts.city) && (
                <g transform={`translate(0 ${PH_HH + 12}) scale(${1 / s})`}>
                  {opts.facility && (
                    <text y="13" textAnchor="middle" fill={C.navy} fontFamily={DISPLAY} fontWeight="600" fontSize="12.5"
                      stroke="#ffffff" strokeWidth="3.4" paintOrder="stroke">{dc.facility}</text>
                  )}
                  {opts.city && (
                    <text y={opts.facility ? 28 : 13} textAnchor="middle" fill={C.steel} fontFamily={BODY} fontSize="11.5"
                      stroke="#ffffff" strokeWidth="3" paintOrder="stroke">{dc.city}</text>
                  )}
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/* ── PDF writer: single page, one DCTDecode image ────────── */
function buildPdf(jpeg, iw, ih) {
  const pw = 842, ph = 595;                        // A4 landscape, points
  const k = Math.min((pw - 40) / iw, (ph - 40) / ih);
  const dw = iw * k, dh = ih * k;
  const ox = (pw - dw) / 2, oy = (ph - dh) / 2;
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const push = (data) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    parts.push(bytes); len += bytes.length;
  };
  const offsets = [];
  const obj = (n, dict, stream) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${dict}\n`);
    if (stream !== undefined) { push("stream\n"); push(stream); push("\nendstream\n"); }
    push("endobj\n");
  };

  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>`, content);

  const xrefAt = len;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const download = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

/* ── export overlay ──────────────────────────────────────── */
function ExportOverlay({ datacenters, links, onClose, onDone }) {
  const [opts, setOpts] = useState(DEFAULT_EXPORT_OPTS);
  const [busy, setBusy] = useState(null);
  const sceneRef = useRef(null);

  const flip = (k) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const flipStatus = (k) => setOpts((o) => ({ ...o, status: { ...o.status, [k]: !o.status[k] } }));

  const rasterise = async (mime, quality) => {
    const svg = sceneRef.current;
    if (!svg) return null;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    });
    const canvas = document.createElement("canvas");
    canvas.width = EXP_W * 2; canvas.height = EXP_H * 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f8fc"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { canvas, data: canvas.toDataURL(mime, quality) };
  };

  const asPng = async () => {
    setBusy("png");
    try {
      const r = await rasterise("image/png");
      if (!r) throw new Error("no scene");
      download(await (await fetch(r.data)).blob(), "polarin-network-topology.png");
      onDone("Image downloaded.");
    } catch { onDone("Export failed. Try again in a moment."); }
    setBusy(null);
  };

  const asPdf = async () => {
    setBusy("pdf");
    try {
      const r = await rasterise("image/jpeg", 0.92);
      if (!r) throw new Error("no scene");
      const jpeg = b64ToBytes(r.data.split(",")[1]);
      const pdf = buildPdf(jpeg, r.canvas.width, r.canvas.height);
      download(new Blob([pdf], { type: "application/pdf" }), "polarin-network-topology.pdf");
      onDone("PDF downloaded.");
    } catch { onDone("Export failed. Try again in a moment."); }
    setBusy(null);
  };

  const Toggle = ({ k, label, hint }) => {
    const on = k.startsWith("status.") ? opts.status[k.slice(7)] : opts[k];
    return (
      <button onClick={() => (k.startsWith("status.") ? flipStatus(k.slice(7)) : flip(k))}
        style={{
          ...btnBare, width: "100%", gap: 10, justifyContent: "flex-start", textAlign: "left",
          borderRadius: 10, padding: "8px 10px", background: on ? "#eff8fa" : "transparent",
        }}>
        <span style={{
          display: "flex", width: 34, height: 20, flexShrink: 0, borderRadius: 999, padding: 2,
          background: on ? C.teal : "#d7e0ea", justifyContent: on ? "flex-end" : "flex-start",
        }}>
          <span style={{ width: 16, height: 16, borderRadius: 999, background: "#fff" }} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontFamily: BODY, fontSize: 13, fontWeight: 600, color: on ? C.navy : C.steel }}>{label}</span>
          {hint && <span style={{ display: "block", fontFamily: BODY, fontSize: 11, color: C.mist }}>{hint}</span>}
        </span>
      </button>
    );
  };

  const groupTitle = { margin: "14px 0 4px", fontFamily: BODY, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: C.steel };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(10,57,84,0.55)", backdropFilter: "blur(3px)",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "80vw", height: "80vh", display: "flex", flexDirection: "column", overflow: "hidden",
        borderRadius: 20, background: "#fff", boxShadow: "0 40px 90px rgba(10,57,84,0.4)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.hair}`, padding: "16px 22px", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: DISPLAY, fontSize: 18, fontWeight: 700, color: C.navy }}>Export topology</h2>
            <p style={{ margin: 0, fontFamily: BODY, fontSize: 12.5, color: C.steel }}>
              Just the topology on its grid — no dashboard, no gradient. Switch details on and off, then download.
            </p>
          </div>
          <button onClick={onClose} style={{ ...btnBare, width: 34, height: 34, borderRadius: 8, color: C.steel }}>
            <Icon path="M6 6l12 12M18 6L6 18" size={18} w={2.2} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* preview */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "#eef3f8", overflow: "auto" }}>
            <div style={{ width: "100%", maxWidth: 1180, borderRadius: 10, overflow: "hidden", border: `1px solid ${C.line}`, boxShadow: "0 14px 34px rgba(10,57,84,0.14)" }}>
              <ExportScene datacenters={datacenters} links={links} opts={opts} sceneRef={sceneRef} />
            </div>
          </div>

          {/* options */}
          <div style={{ width: 292, flexShrink: 0, borderLeft: `1px solid ${C.hair}`, overflowY: "auto", padding: "10px 16px 20px" }}>
            <p style={groupTitle}>PoP details</p>
            <Toggle k="facility" label="Facility name" />
            <Toggle k="city" label="City" />
            <Toggle k="provider" label="Provider logo" />
            <Toggle k="ports" label="Port count" />

            <p style={groupTitle}>Connections</p>
            <Toggle k="links" label="Show connections" />
            <Toggle k="capacity" label="Capacity label" hint="e.g. 100 Gbps at each bend" />

            <p style={groupTitle}>Include PoPs</p>
            <Toggle k="status.live" label="Live" />
            <Toggle k="status.down" label="Down" />
            <Toggle k="status.design" label="In design" />

            <p style={groupTitle}>Page</p>
            <Toggle k="grid" label="Grid background" />
            <Toggle k="title" label="Title block" hint="Name, counts and date" />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderTop: `1px solid ${C.hair}`, padding: "14px 22px", flexShrink: 0 }}>
          <p style={{ margin: 0, fontFamily: BODY, fontSize: 12, color: C.mist }}>3200 × 1800 · saved to your downloads</p>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={asPng} disabled={busy !== null} style={{
              ...btnBare, gap: 8, borderRadius: 10, border: `1px solid ${C.line}`, background: "#fff",
              padding: "10px 16px", fontFamily: DISPLAY, fontSize: 13.5, fontWeight: 600, color: C.ink, opacity: busy ? 0.5 : 1 }}>
              <Icon path="M4 16l4-5 4 4 3-3 5 6M4 4h16v16H4z" size={16} />
              {busy === "png" ? "Preparing…" : "Download image"}
            </button>
            <button onClick={asPdf} disabled={busy !== null} style={{
              ...btnBare, gap: 8, borderRadius: 10, background: C.teal, padding: "10px 18px",
              fontFamily: DISPLAY, fontSize: 13.5, fontWeight: 600, color: "#fff", opacity: busy ? 0.5 : 1 }}>
              <Icon path="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" size={16} />
              {busy === "pdf" ? "Preparing…" : "Download PDF"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── add datacenter ──────────────────────────────────────── */
const PROVIDERS = [
  { name: "Sify", color: "#93c020" }, { name: "NTT", color: "#0071c5" }, { name: "STT", color: "#e8542a" },
  { name: "CtrlS", color: "#1f7ae0" }, { name: "Jio", color: "#0a3fa8" }, { name: "Equinix", color: "#d90429" },
  { name: "AWS", color: "#ff9900" }, { name: "Google", color: "#ea4335" }, { name: "Khazna", color: "#7a5cff" },
];

function AddDatacenterDialog({ datacenters, onAdd, onClose }) {
  const [facility, setFacility] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("India");
  const [provider, setProvider] = useState(PROVIDERS[0]);
  const [status, setStatus] = useState("design");
  const [kind, setKind] = useState("rack");
  const [ports, setPorts] = useState(2);

  const ready = facility.trim() && city.trim();
  const spot = useMemo(
    () => (city.trim() ? proposeSlot(datacenters, city, country) : null),
    [datacenters, city, country]
  );
  const peer = useMemo(() => {
    const same = datacenters.filter((d) => d.city.toLowerCase() === city.trim().toLowerCase());
    if (same.length) return same.find((d) => d.status === "live") ?? same[0];
    const co = datacenters.filter((d) => d.country.toLowerCase() === country.trim().toLowerCase());
    return co.length ? (co.find((d) => d.status === "live") ?? co[0]) : null;
  }, [datacenters, city, country]);

  const submit = () => {
    if (!ready || !spot) return;
    onAdd({
      id: `dc-${Date.now()}`, facility: facility.trim(), city: city.trim(), country: country.trim() || "—",
      provider: provider.name, providerColor: provider.color, status, kind, ports: Number(ports) || 2,
      u: spot.u, v: spot.v, ordered: [], available: CATALOG,
    }, peer);
  };

  const field = { width: "100%", boxSizing: "border-box", borderRadius: 12, border: `1px solid ${C.line}`, background: "#f8fafb", padding: "10px 14px", fontFamily: BODY, fontSize: 14, color: C.navy, outline: "none" };
  const label = { marginBottom: 6, display: "block", fontFamily: DISPLAY, fontSize: 12, fontWeight: 600, color: C.steel };
  const seg = (on) => ({ ...btnBare, flex: 1, borderRadius: 8, padding: "8px 6px", fontFamily: BODY, fontSize: 13, fontWeight: 500, border: `1px solid ${on ? C.teal : C.line}`, background: on ? "#eaf6f9" : "#fff", color: on ? C.navy : C.steel });

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(10,57,84,0.45)" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 500, overflow: "hidden", borderRadius: 24, background: "#fff", boxShadow: "0 30px 60px rgba(10,57,84,0.35)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.hair}`, padding: "20px 24px" }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: DISPLAY, fontSize: 19, fontWeight: 700, color: C.navy }}>Add a datacenter</h2>
            <p style={{ margin: 0, fontFamily: BODY, fontSize: 13, color: C.steel }}>It lands on the nearest free grid point. Drag it later to move it.</p>
          </div>
          <button onClick={onClose} style={{ ...btnBare, width: 36, height: 36, borderRadius: 8, color: C.steel }}>
            <Icon path="M6 6l12 12M18 6L6 18" size={18} w={2.2} />
          </button>
        </div>

        <div style={{ maxHeight: "58vh", overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={label}>Facility name</label>
            <input value={facility} onChange={(e) => setFacility(e.target.value)} placeholder="e.g. NTT Ambattur" style={field} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label style={label}>City</label><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Chennai" style={field} /></div>
            <div><label style={label}>Country</label><input value={country} onChange={(e) => setCountry(e.target.value)} style={field} /></div>
          </div>

          <div>
            <label style={label}>Provider</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {PROVIDERS.map((p) => {
                const on = provider.name === p.name;
                return (
                  <button key={p.name} onClick={() => setProvider(p)} style={{
                    ...btnBare, gap: 8, borderRadius: 8, padding: "6px 12px", fontFamily: BODY, fontSize: 13, fontWeight: 500,
                    border: on ? "1px solid transparent" : `1px solid ${C.line}`, background: on ? p.color : "#fff", color: on ? "#fff" : C.ink }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: on ? "#fff" : p.color }} />{p.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={label}>Starting status</label>
              <div style={{ display: "flex", gap: 8 }}>
                {["design", "live", "down"].map((k) => (
                  <button key={k} onClick={() => setStatus(k)} style={{ ...seg(status === k), textTransform: "capitalize" }}>{k}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={label}>Node type</label>
              <div style={{ display: "flex", gap: 8 }}>
                {[["rack", "Rack"], ["cloud", "Cloud on-ramp"]].map(([k, l]) => (
                  <button key={k} onClick={() => setKind(k)} style={seg(kind === k)}>{l}</button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, alignItems: "end" }}>
            <div><label style={label}>Ports</label><input type="number" min="1" max="48" value={ports} onChange={(e) => setPorts(e.target.value)} style={field} /></div>
            <div style={{ borderRadius: 12, background: "#f4f9fb", border: "1px solid #dcebef", padding: "10px 14px" }}>
              <p style={{ margin: 0, fontFamily: BODY, fontSize: 12.5, color: C.ink }}>
                {spot
                  ? `Grid point ${spot.u}, ${spot.v}${peer ? ` — next to ${peer.facility}` : " — on the eastern edge"}.`
                  : "Enter a city to see the grid point it will take."}
              </p>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, borderTop: `1px solid ${C.hair}`, padding: "16px 24px" }}>
          <button onClick={onClose} style={{ ...btnBare, borderRadius: 8, padding: "10px 16px", fontFamily: DISPLAY, fontSize: 14, fontWeight: 600, color: C.steel }}>Cancel</button>
          <button onClick={submit} disabled={!ready} style={{
            ...btnBare, borderRadius: 8, background: C.teal, padding: "10px 20px", fontFamily: DISPLAY, fontSize: 14, fontWeight: 600, color: "#fff",
            opacity: ready ? 1 : 0.4, cursor: ready ? "pointer" : "not-allowed" }}>Place on grid</button>
        </div>
      </div>
    </div>
  );
}

/* ── header ──────────────────────────────────────────────── */
/* Material Symbols glyphs used only in the header — filled paths, not stroked */
function ContactSupportIcon({ size = 24, color = C.steel }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path fill={color} d="M11.75 19H11.5C9.13333 19 7.125 18.175 5.475 16.525C3.825 14.875 3 12.8667 3 10.5C3 8.13333 3.825 6.125 5.475 4.475C7.125 2.825 9.13333 2 11.5 2C12.6833 2 13.7875 2.22083 14.8125 2.6625C15.8375 3.10417 16.7375 3.7125 17.5125 4.4875C18.2875 5.2625 18.8958 6.1625 19.3375 7.1875C19.7792 8.2125 20 9.31667 20 10.5C20 12.7333 19.3708 14.8083 18.1125 16.725C16.8542 18.6417 15.2667 20.1417 13.35 21.225C13.1833 21.3083 13.0167 21.3542 12.85 21.3625C12.6833 21.3708 12.5333 21.3333 12.4 21.25C12.2667 21.1667 12.15 21.0583 12.05 20.925C11.95 20.7917 11.8917 20.6333 11.875 20.45L11.75 19ZM14 18.35C15.1833 17.35 16.1458 16.1792 16.8875 14.8375C17.6292 13.4958 18 12.05 18 10.5C18 8.68333 17.3708 7.14583 16.1125 5.8875C14.8542 4.62917 13.3167 4 11.5 4C9.68333 4 8.14583 4.62917 6.8875 5.8875C5.62917 7.14583 5 8.68333 5 10.5C5 12.3167 5.62917 13.8542 6.8875 15.1125C8.14583 16.3708 9.68333 17 11.5 17H14V18.35ZM11.475 15.975C11.7583 15.975 12 15.875 12.2 15.675C12.4 15.475 12.5 15.2333 12.5 14.95C12.5 14.6667 12.4 14.425 12.2 14.225C12 14.025 11.7583 13.925 11.475 13.925C11.1917 13.925 10.95 14.025 10.75 14.225C10.55 14.425 10.45 14.6667 10.45 14.95C10.45 15.2333 10.55 15.475 10.75 15.675C10.95 15.875 11.1917 15.975 11.475 15.975ZM9.3 8.375C9.48333 8.45833 9.66667 8.4625 9.85 8.3875C10.0333 8.3125 10.1833 8.19167 10.3 8.025C10.45 7.825 10.625 7.67083 10.825 7.5625C11.025 7.45417 11.25 7.4 11.5 7.4C11.9 7.4 12.225 7.5125 12.475 7.7375C12.725 7.9625 12.85 8.25 12.85 8.6C12.85 8.81667 12.7875 9.03333 12.6625 9.25C12.5375 9.46667 12.3167 9.73333 12 10.05C11.5833 10.4167 11.275 10.7625 11.075 11.0875C10.875 11.4125 10.775 11.7417 10.775 12.075C10.775 12.275 10.8458 12.4458 10.9875 12.5875C11.1292 12.7292 11.3 12.8 11.5 12.8C11.7 12.8 11.8667 12.725 12 12.575C12.1333 12.425 12.2333 12.25 12.3 12.05C12.3833 11.7667 12.5333 11.5083 12.75 11.275C12.9667 11.0417 13.1667 10.8333 13.35 10.65C13.7 10.3 13.9625 9.95 14.1375 9.6C14.3125 9.25 14.4 8.9 14.4 8.55C14.4 7.78333 14.1375 7.16667 13.6125 6.7C13.0875 6.23333 12.3833 6 11.5 6C10.9667 6 10.475 6.12917 10.025 6.3875C9.575 6.64583 9.20833 7 8.925 7.45C8.825 7.63333 8.8125 7.8125 8.8875 7.9875C8.9625 8.1625 9.1 8.29167 9.3 8.375Z" />
    </svg>
  );
}
function NotificationsUnreadIcon({ size = 24, color = C.steel }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path fill={color} d="M12 22C11.45 22 10.9792 21.8042 10.5875 21.4125C10.1958 21.0208 10 20.55 10 20H14C14 20.55 13.8042 21.0208 13.4125 21.4125C13.0208 21.8042 12.55 22 12 22ZM5 19C4.71667 19 4.47917 18.9042 4.2875 18.7125C4.09583 18.5208 4 18.2833 4 18C4 17.7167 4.09583 17.4792 4.2875 17.2875C4.47917 17.0958 4.71667 17 5 17H6V10C6 8.61667 6.41667 7.3875 7.25 6.3125C8.08333 5.2375 9.16667 4.53333 10.5 4.2V3.5C10.5 3.08333 10.6458 2.72917 10.9375 2.4375C11.2292 2.14583 11.5833 2 12 2C12.4167 2 12.7708 2.14583 13.0625 2.4375C13.3542 2.72917 13.5 3.08333 13.5 3.5V3.825C13.3167 4.19167 13.1833 4.56667 13.1 4.95C13.0167 5.33333 12.9833 5.725 13 6.125C12.8333 6.09167 12.6708 6.0625 12.5125 6.0375C12.3542 6.0125 12.1833 6 12 6C10.9 6 9.95833 6.39167 9.175 7.175C8.39167 7.95833 8 8.9 8 10V17H16V10.575C16.3 10.7083 16.6208 10.8125 16.9625 10.8875C17.3042 10.9625 17.65 11 18 11V17H19C19.2833 17 19.5208 17.0958 19.7125 17.2875C19.9042 17.4792 20 17.7167 20 18C20 18.2833 19.9042 18.5208 19.7125 18.7125C19.5208 18.9042 19.2833 19 19 19H5ZM18 9C17.1667 9 16.4583 8.70833 15.875 8.125C15.2917 7.54167 15 6.83333 15 6C15 5.16667 15.2917 4.45833 15.875 3.875C16.4583 3.29167 17.1667 3 18 3C18.8333 3 19.5417 3.29167 20.125 3.875C20.7083 4.45833 21 5.16667 21 6C21 6.83333 20.7083 7.54167 20.125 8.125C19.5417 8.70833 18.8333 9 18 9Z" />
      <circle cx="18" cy="6" r="3" fill={C.down} />
    </svg>
  );
}
function ExpandCircleDownIcon({ size = 24, color = C.steel }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path fill={color} d="M12 12.675L9.625 10.3C9.44167 10.1167 9.2125 10.025 8.9375 10.025C8.6625 10.025 8.425 10.1167 8.225 10.3C8.025 10.5 7.925 10.7375 7.925 11.0125C7.925 11.2875 8.025 11.525 8.225 11.725L11.3 14.8C11.5 15 11.7333 15.1 12 15.1C12.2667 15.1 12.5 15 12.7 14.8L15.8 11.7C16 11.5 16.0958 11.2667 16.0875 11C16.0792 10.7333 15.975 10.5 15.775 10.3C15.575 10.1167 15.3417 10.0208 15.075 10.0125C14.8083 10.0042 14.575 10.1 14.375 10.3L12 12.675ZM12 22C10.6167 22 9.31667 21.7375 8.1 21.2125C6.88333 20.6875 5.825 19.975 4.925 19.075C4.025 18.175 3.3125 17.1167 2.7875 15.9C2.2625 14.6833 2 13.3833 2 12C2 10.6167 2.2625 9.31667 2.7875 8.1C3.3125 6.88333 4.025 5.825 4.925 4.925C5.825 4.025 6.88333 3.3125 8.1 2.7875C9.31667 2.2625 10.6167 2 12 2C13.3833 2 14.6833 2.2625 15.9 2.7875C17.1167 3.3125 18.175 4.025 19.075 4.925C19.975 5.825 20.6875 6.88333 21.2125 8.1C21.7375 9.31667 22 10.6167 22 12C22 13.3833 21.7375 14.6833 21.2125 15.9C20.6875 17.1167 19.975 18.175 19.075 19.075C18.175 19.975 17.1167 20.6875 15.9 21.2125C14.6833 21.7375 13.3833 22 12 22ZM12 20C14.2333 20 16.125 19.225 17.675 17.675C19.225 16.125 20 14.2333 20 12C20 9.76667 19.225 7.875 17.675 6.325C16.125 4.775 14.2333 4 12 4C9.76667 4 7.875 4.775 6.325 6.325C4.775 7.875 4 9.76667 4 12C4 14.2333 4.775 16.125 6.325 17.675C7.875 19.225 9.76667 20 12 20Z" />
    </svg>
  );
}

function IconChip({ children }) {
  return (
    <div style={{ display: "flex", width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 999, background: "#f8fafb", border: `1px solid ${C.line}`, flexShrink: 0 }}>
      {children}
    </div>
  );
}

function Header() {
  const nav = ["Dashboard", "Services", "Settings", "Help"];
  return (
    <div style={{ display: "flex", height: 72, alignItems: "center", justifyContent: "space-between", background: "#ffffff", borderBottom: "0.5px solid #e2e8f1", padding: "0 24px" }}>
      <img src="/polarin-mark.svg" alt="Polarin" style={{ height: 28, width: "auto", display: "block" }} />

      <nav style={{ display: "flex", alignItems: "center", height: "100%" }}>
        {nav.map((n, i) => (
          <div key={n} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, height: "100%", justifyContent: "center" }}>
            <button style={{ ...btnBare, padding: "0 16px", fontFamily: BODY, fontSize: 14, fontWeight: 700, color: i === 0 ? C.teal : C.navy }}>{n}</button>
            <div style={{ width: "100%", height: 2, background: i === 0 ? C.teal : "transparent" }} />
          </div>
        ))}
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <IconChip><ContactSupportIcon size={20} /></IconChip>
        <IconChip><NotificationsUnreadIcon size={20} /></IconChip>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
          <img src="/user-avatar.png" alt="" style={{ width: 32, height: 32, borderRadius: 999, objectFit: "cover", border: `1px solid ${C.line}`, flexShrink: 0 }} />
          <div style={{ lineHeight: 1.3 }}>
            <p style={{ margin: 0, fontFamily: BODY, fontSize: 12, fontWeight: 700, color: C.navy }}>Abram Qureshi</p>
            <p style={{ margin: 0, fontFamily: BODY, fontSize: 12, fontWeight: 700, color: C.steel }}>Admin</p>
          </div>
          <ExpandCircleDownIcon size={20} />
        </div>
      </div>
    </div>
  );
}

/* ── app ─────────────────────────────────────────────────── */
export default function App() {
  const [datacenters, setDatacenters] = useState(SEED);
  const [links, setLinks] = useState(SEED_LINKS);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedLinkId, setSelectedLinkId] = useState(null);
  const [filters, setFilters] = useState({ live: true, down: true, design: true });
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [readout, setReadout] = useState({ scale: 0.8, pops: SEED.length });
  const [toast, setToast] = useState(null);
  const svgRef = useRef(null);
  const controls = useRef(null);

  const onView = useCallback((scale, pops) => setReadout({ scale, pops }), []);
  const toggle = (s) => setFilters((f) => ({ ...f, [s]: !f[s] }));
  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  const selected = datacenters.find((d) => d.id === selectedId) ?? null;
  const selectedLink = links.find((l) => linkId(l) === selectedLinkId) ?? null;
  const linkEnds = selectedLink
    ? {
        a: datacenters.find((d) => d.id === selectedLink.from),
        b: datacenters.find((d) => d.id === selectedLink.to),
      }
    : null;
  const drawerOpen = Boolean(selected || (selectedLink && linkEnds?.a && linkEnds?.b));

  const pickNode = (dc) => { setSelectedLinkId(null); setSelectedId(dc.id); };
  const pickLink = (l) => { setSelectedId(null); setSelectedLinkId(linkId(l)); };
  const closeDrawer = () => { setSelectedId(null); setSelectedLinkId(null); };

  const stats = useMemo(() => {
    let total = 0, live = 0, attention = 0;
    datacenters.forEach((d) => d.ordered.forEach((s) => { total++; if (s.status === "live") live++; if (s.status === "down") attention++; }));
    const counts = { live: 0, down: 0, design: 0 };
    datacenters.forEach((d) => (counts[d.status] += 1));
    return { total, live, attention, counts };
  }, [datacenters]);

  /* place or move a PoP: the grid point is re-checked, and pushed to the
     nearest free point if the requested one is taken */
  const placeNode = (id, u, v) => {
    const spot = nearestFreeSlot(datacenters, u, v, id);
    setDatacenters((all) => all.map((d) => (d.id === id ? { ...d, u: spot.u, v: spot.v } : d)));
    if (spot.u !== u || spot.v !== v) flash(`That point was too tight. Moved to ${spot.u}, ${spot.v}.`);
  };

  const addDatacenter = (dc, peer) => {
    const spot = nearestFreeSlot(datacenters, dc.u, dc.v);
    const placed = { ...dc, u: spot.u, v: spot.v };
    setDatacenters((all) => [...all, placed]);
    if (peer) setLinks((ls) => [...ls, { from: peer.id, to: placed.id, status: placed.status === "live" ? "live" : "design", gbps: 10 }]);
    setAdding(false);
    setSelectedLinkId(null);
    setSelectedId(placed.id);
    flash(`${placed.facility} placed at grid ${spot.u}, ${spot.v}.`);
    setTimeout(() => controls.current?.centreOn(placed.id), 80);
  };

  const resetAll = () => {
    setDatacenters(SEED);
    setLinks(SEED_LINKS);
    setSelectedId(null);
    setSelectedLinkId(null);
    setFilters({ live: true, down: true, design: true });
    setTimeout(() => controls.current?.home(), 60);
    flash("Back to the default view at 100%.");
  };

  const viewBtn = (active) => ({ ...btnBare, width: 44, height: 44, borderBottom: `1px solid ${C.hair}`, background: active ? C.teal : "transparent", color: active ? "#fff" : C.steel });
  const stackShell = { display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: 16, border: `1px solid ${C.line}`, background: "rgba(255,255,255,0.95)", boxShadow: "0 12px 28px rgba(10,57,84,0.12)", backdropFilter: "blur(6px)" };
  const ghostBtn = { ...btnBare, gap: 8, borderRadius: 12, border: "1px solid #d5dfea", background: "#fff", padding: "9px 15px", fontFamily: DISPLAY, fontSize: 14, fontWeight: 600, color: C.ink };

  return (
    <div style={{ position: "relative", display: "flex", height: "100vh", width: "100%", flexDirection: "column", overflow: "hidden", background: C.canvas }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Lato:wght@400;500;700;900&display=swap');
        * { box-sizing: border-box; }
        input::placeholder { color: ${C.mist}; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 8px; }
      `}</style>

      <header style={{ zIndex: 20, flexShrink: 0 }}><Header /></header>

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <IsometricMap
          datacenters={datacenters} links={links} filters={filters}
          selectedId={selectedId} selectedLinkId={selectedLinkId}
          onSelect={pickNode} onSelectLink={pickLink} onPlace={placeNode}
          svgRef={svgRef} controlsRef={controls} onView={onView}
          insetLeft={300} insetRight={drawerOpen ? 440 : 96}
        />

        {/* left dashboard */}
        <div style={{
          pointerEvents: "none", position: "absolute", top: 0, bottom: 0, left: 0, width: 344, maxWidth: "80%",
          display: "flex", flexDirection: "column", gap: 22, padding: "32px 32px 28px",
          background: "linear-gradient(to right, #f8fafc 0%, #f8fafc 56%, rgba(248,250,252,0) 100%)",
        }}>
          <div style={{ pointerEvents: "auto" }}>
            <p style={{ margin: 0, fontFamily: BODY, fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.steel }}>
              Good morning <span style={{ color: C.pale }}>· Sep 10</span>
            </p>
            <h1 style={{ margin: "4px 0 0", fontFamily: DISPLAY, fontSize: 29, fontWeight: 700, lineHeight: 1.2, color: C.navy }}>Hey, Abram!</h1>
          </div>

          <div style={{ pointerEvents: "auto" }}>
            <p style={{ margin: 0, fontFamily: BODY, fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.steel }}>Total services</p>
            <p style={{ margin: 0, fontFamily: DISPLAY, fontSize: 48, fontWeight: 700, lineHeight: 1, color: C.navy }}>{stats.total}</p>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5, fontFamily: BODY, fontSize: 14, color: C.ink }}>
              <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: C.live }} />{stats.live} live and kicking</p>
              <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: C.down }} />{stats.attention} need your attention</p>
              <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, color: C.steel }}><span style={{ width: 8, height: 8, borderRadius: 3, background: C.pale }} />{datacenters.length} PoPs on the grid</p>
            </div>
          </div>

          <button onClick={() => setAdding(true)} style={{
            ...btnBare, pointerEvents: "auto", gap: 12, borderRadius: 16,
            background: `linear-gradient(to bottom, ${C.navy}, ${C.teal})`, padding: 15, textAlign: "left",
            boxShadow: "0 14px 30px rgba(10,57,84,0.24)" }}>
            <span style={{ display: "flex", width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 12, background: "rgba(255,255,255,0.15)", color: "#fff" }}>
              <Icon path="M12 5v14M5 12h14" />
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontFamily: DISPLAY, fontSize: 15, fontWeight: 700, color: "#fff" }}>Add a datacenter</span>
              <span style={{ display: "block", fontFamily: BODY, fontSize: 12, color: C.sky }}>Snaps to the nearest free grid point</span>
            </span>
          </button>

          <div style={{ pointerEvents: "auto", display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button onClick={() => setExporting(true)} style={ghostBtn}>
              <Icon path="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" size={17} />Export
            </button>
          </div>

          <p style={{ pointerEvents: "auto", margin: 0, maxWidth: 250, fontFamily: BODY, fontSize: 12, lineHeight: 1.5, color: C.steel }}>
            Each PoP takes a 2 × 2 block of grid cells. Drag one to move it — it snaps to grid points and turns red where another PoP in the same column is closer than four cells. Click a connection for its capacity and latency.
          </p>
        </div>

        {/* right toolbar */}
        <div style={{ position: "absolute", right: 24, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={stackShell}>
            <button title="Globe" style={viewBtn(false)}><Icon path="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2c3 3 3 17 0 20M12 2c-3 3-3 17 0 20" size={18} /></button>
            <button title="Map" style={viewBtn(false)}><Icon path="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" size={18} /></button>
            <button title="Topology" style={{ ...viewBtn(true), borderBottom: "none" }}><Icon path="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7.5 7.5l3 6M16.5 7.5l-3 6" size={18} /></button>
          </div>
          <div style={stackShell}>
            <button title="Zoom in" onClick={() => controls.current?.zoomIn()} style={{ ...viewBtn(false), color: C.ink }}><Icon path="M11 5v12M5 11h12" size={18} /></button>
            <button title="Zoom out" onClick={() => controls.current?.zoomOut()} style={{ ...viewBtn(false), color: C.ink }}><Icon path="M5 11h12" size={18} /></button>
            <button title="Fit to view" onClick={() => controls.current?.fit()} style={{ ...viewBtn(false), color: C.ink }}><Icon path="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" size={18} /></button>
            <button title="Reset to default view" onClick={resetAll} style={{ ...viewBtn(false), color: C.ink, borderBottom: "none" }}><Icon path="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" size={18} /></button>
          </div>
        </div>

        <div style={{ position: "absolute", bottom: 20, left: 20, borderRadius: 8, border: `1px solid ${C.line}`, background: "rgba(255,255,255,0.9)", padding: "6px 12px", fontFamily: BODY, fontSize: 12, color: C.steel }}>
          {Math.round(readout.scale * 100)}% · {readout.pops} PoPs
        </div>

        {/* legend / filters */}
        <div style={{
          position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)",
          display: "flex", alignItems: "center", gap: 4, borderRadius: 999, border: `1px solid ${C.line}`,
          background: "rgba(255,255,255,0.95)", padding: "6px 8px", boxShadow: "0 12px 28px rgba(10,57,84,0.12)", backdropFilter: "blur(6px)" }}>
          {["live", "down", "design"].map((k) => {
            const on = filters[k], meta = STATUS[k];
            return (
              <button key={k} onClick={() => toggle(k)} style={{
                ...btnBare, gap: 6, borderRadius: 999, padding: "4px 12px", fontFamily: BODY, fontSize: 13, fontWeight: 500,
                color: on ? C.ink : C.pale, textDecoration: on ? "none" : "line-through" }}>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: on ? meta.color : C.pale }} />
                {meta.label}<span style={{ color: C.mist }}>{stats.counts[k]}</span>
              </button>
            );
          })}
          <span style={{ margin: "0 4px", width: 1, height: 16, background: C.line }} />
          <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", fontFamily: BODY, fontSize: 13, color: C.ink }}>
            <span style={{ color: C.navy, display: "inline-flex" }}><Icon path="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" size={13} /></span>Rack PoP
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", fontFamily: BODY, fontSize: 13, color: C.ink }}>
            <span style={{ width: 12, height: 8, borderRadius: 4, background: C.sky, border: `1px solid ${C.tealBright}` }} />Cloud on-ramp
          </span>
        </div>

        {/* detail drawer: a PoP or a connection */}
        <div style={{
          position: "absolute", top: 0, bottom: 0, right: 0, zIndex: 30, width: "100%", maxWidth: 440,
          borderLeft: `1px solid ${C.line}`, background: "#fff", boxShadow: "-16px 0 40px rgba(10,57,84,0.10)",
          transform: drawerOpen ? "translateX(0)" : "translateX(100%)",
          transition: "transform 300ms cubic-bezier(0.22,0.61,0.36,1)" }}>
          {selected && <ServicePanel dc={selected} onClose={closeDrawer} />}
          {!selected && selectedLink && linkEnds?.a && linkEnds?.b && (
            <LinkPanel link={selectedLink} aEnd={linkEnds.a} bEnd={linkEnds.b}
              onClose={closeDrawer} onOpenEnd={(id) => { setSelectedLinkId(null); setSelectedId(id); }} />
          )}
        </div>

        {toast && (
          <div style={{
            position: "absolute", bottom: 92, left: 32, zIndex: 40, borderRadius: 10, background: C.navy, color: "#fff",
            padding: "10px 16px", fontFamily: BODY, fontSize: 13, boxShadow: "0 14px 30px rgba(10,57,84,0.3)" }}>{toast}</div>
        )}

        {adding && (
          <AddDatacenterDialog datacenters={datacenters} onClose={() => setAdding(false)} onAdd={addDatacenter} />
        )}

        {exporting && (
          <ExportOverlay datacenters={datacenters} links={links}
            onClose={() => setExporting(false)}
            onDone={(m) => { setExporting(false); flash(m); }} />
        )}
      </div>
    </div>
  );
}
