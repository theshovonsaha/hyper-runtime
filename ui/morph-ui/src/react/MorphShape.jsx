import React, { useEffect, useMemo, useRef, useState } from "react";
import { shapePath } from "../core/shapes.js";

/**
 * <MorphShape type="hexagon" size={40} color="#8B5CF6" />
 *
 * Static by default (path only updates when `type`/`seed` props change —
 * CSS `transition: d` on .morph-shape-path handles the smooth morph).
 * Pass `animate` for continuous ambient motion (a live/processing feel).
 */
export function MorphShape({
  type = "circle",
  size = 40,
  color = "#8B5CF6",
  seed = 0,
  numPoints = 20,
  animate = false,
  speed = 0.3,
  className = "",
  style = {},
}) {
  const reduceMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const [d, setD] = useState(() => shapePath(type, size / 2 - 2, seed, numPoints));
  const seedRef = useRef(seed);

  // static mode: recompute only when inputs change
  useEffect(() => {
    if (animate) return;
    setD(shapePath(type, size / 2 - 2, seed, numPoints));
  }, [type, seed, size, numPoints, animate]);

  // animated mode: continuous rAF loop
  useEffect(() => {
    if (!animate || reduceMotion) return;
    let raf;
    let mounted = true;
    function frame(t) {
      if (!mounted) return;
      seedRef.current = (t / 1000) * speed;
      setD(shapePath(type, size / 2 - 2, seedRef.current, numPoints));
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
  }, [animate, reduceMotion, type, size, numPoints, speed]);

  return (
    <svg
      className={"morph-shape " + className}
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={style}
    >
      <path className="morph-shape-path" d={d} fill={color} />
    </svg>
  );
}

export default MorphShape;
