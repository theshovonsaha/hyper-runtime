/**
 * morph-ui/core — framework-agnostic shape engine.
 * No React, no DOM. Pure math + a registry so new shapes are pluggable.
 */

function polygonRadius(theta, R, k, rotation) {
  const t = theta - rotation;
  const seg = (2 * Math.PI) / k;
  let a = ((t % seg) + seg) % seg - seg / 2;
  return (R * Math.cos(seg / 2)) / Math.cos(a);
}

/**
 * A shape is just a function: (theta, R, seed) => radius at that angle.
 * Register your own and every MorphShape/BlobAvatar in the app can use it immediately.
 */
export const SHAPE_REGISTRY = {
  circle: (theta, R) => R,
  triangle: (theta, R) => polygonRadius(theta, R, 3, -Math.PI / 2) * 0.92,
  square: (theta, R) => polygonRadius(theta, R, 4, -Math.PI / 4),
  pentagon: (theta, R) => polygonRadius(theta, R, 5, -Math.PI / 2),
  hexagon: (theta, R) => polygonRadius(theta, R, 6, 0),
  star: (theta, R, seed = 0) => R * (0.5 + 0.5 * Math.cos(5 * theta - seed)),
  blob: (theta, R, seed = 0) =>
    R * (1 + 0.24 * Math.sin(3 * theta + seed) + 0.09 * Math.sin(5 * theta - seed * 1.6)),
};

/** Add or override a shape. radiusFn: (theta, R, seed) => number */
export function registerShape(name, radiusFn) {
  SHAPE_REGISTRY[name] = radiusFn;
}

export function listShapes() {
  return Object.keys(SHAPE_REGISTRY);
}

export function buildPoints(type, R, seed = 0, numPoints = 20) {
  const radiusFn = SHAPE_REGISTRY[type] || SHAPE_REGISTRY.circle;
  const pts = [];
  for (let i = 0; i < numPoints; i++) {
    const theta = -Math.PI / 2 + i * ((2 * Math.PI) / numPoints);
    const r = radiusFn(theta, R, seed);
    pts.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
  }
  return pts;
}

/** Catmull-Rom -> cubic bezier, closed loop. Same point count in = same command
 *  structure out, which is what lets browsers animate the `d` attribute smoothly. */
export function catmullRom2bezier(points) {
  const n = points.length;
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} `;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} `;
  }
  return d + "Z";
}

/** Convenience: shape name -> path `d` string in one call. */
export function shapePath(type, R, seed = 0, numPoints = 20) {
  return catmullRom2bezier(buildPoints(type, R, seed, numPoints));
}
