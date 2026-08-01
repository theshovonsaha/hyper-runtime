import React, { useEffect, useRef } from "react";
import { shapePath } from "morph-ui/core";

const PALETTE = [
  "#8B5CF6", // violet
  "#22D3EE", // cyan
  "#EC4899", // pink
  "#FBBF24", // amber
  "#A3E635", // lime
  "#FB7185"  // coral
];

const SHAPES = ["circle", "triangle", "square", "pentagon", "hexagon", "star", "blob"];

function pickDifferent(list, current) {
  let next = current;
  while (next === current) {
    next = list[Math.floor(Math.random() * list.length)];
  }
  return next;
}

function rand(min, max) { return min + Math.random() * (max - min); }

export function BlobPlayground() {
  const containerRef = useRef(null);

  useEffect(() => {
    const layer = containerRef.current;
    if (!layer) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const svgNS = "http://www.w3.org/2000/svg";

    const BASE_POS = [
      { x: 300, y: 260 }, { x: 560, y: 230 }, { x: 430, y: 400 },
      { x: 640, y: 420 }, { x: 230, y: 430 }
    ];

    const blobs = BASE_POS.map((pos, i) => ({
      id: i,
      type: SHAPES[i % SHAPES.length],
      color: PALETTE[i % PALETTE.length],
      seed: Math.random() * Math.PI * 2,
      R: rand(70, 96),
      baseX: pos.x,
      baseY: pos.y,
      driftAmpX: rand(26, 46),
      driftAmpY: rand(20, 38),
      driftSpeed: rand(0.15, 0.30),
      phase: rand(0, Math.PI * 2),
      scale: 1,
      targetScale: 1
    }));

    const elements = blobs.map((b) => {
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "blob");
      g.style.cursor = "pointer";
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("fill", b.color);
      path.style.transition = "d 0.85s cubic-bezier(0.65,0,0.35,1), fill 0.7s ease";
      path.setAttribute("d", shapePath(b.type, b.R, b.seed));
      g.appendChild(path);
      layer.appendChild(g);

      g.addEventListener("pointerdown", () => {
        b.type = pickDifferent(SHAPES, b.type);
        b.color = pickDifferent(PALETTE, b.color);
        b.seed = Math.random() * Math.PI * 2;
        path.setAttribute("d", shapePath(b.type, b.R, b.seed));
        path.setAttribute("fill", b.color);
        b.targetScale = 1.14;
        setTimeout(() => { b.targetScale = 1; }, 260);
      });

      return { g, path, b };
    });

    let rafId;
    function frame(t) {
      const time = t / 1000;
      elements.forEach(({ g, b }) => {
        const dx = Math.sin(time * b.driftSpeed + b.phase) * b.driftAmpX;
        const dy = Math.cos(time * b.driftSpeed * 1.3 + b.phase) * b.driftAmpY;
        b.scale += (b.targetScale - b.scale) * 0.12;
        const x = b.baseX + dx;
        const y = b.baseY + dy;
        g.setAttribute("transform", `translate(${x.toFixed(2)}, ${y.toFixed(2)}) scale(${b.scale.toFixed(3)})`);
      });
      if (!reduceMotion) rafId = requestAnimationFrame(frame);
    }

    if (reduceMotion) {
      elements.forEach(({ g, b }) => {
        g.setAttribute("transform", `translate(${b.baseX}, ${b.baseY})`);
      });
    } else {
      rafId = requestAnimationFrame(frame);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (layer) layer.innerHTML = "";
    };
  }, []);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, padding: "32px 20px" }}>
      <header style={{ textAlign: "center", maxWidth: 520 }}>
        <p style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--ink-dim)", margin: "0 0 10px" }}>
          Interactive · SVG · Gooey layers
        </p>
        <h1 style={{ margin: "0 0 8px", fontSize: "clamp(22px, 4vw, 32px)", fontWeight: 600, letterSpacing: "-0.01em" }}>
          Click a shape to morph it
        </h1>
        <p style={{ margin: 0, color: "var(--ink-dim)", fontSize: 14, lineHeight: 1.5 }}>
          Each layer flows into a new form and color when touched. Bring two close together and watch them fuse into one connected body.
        </p>
      </header>

      <div style={{
        width: "min(94vw, 780px)",
        aspectRatio: "9 / 6.2",
        borderRadius: 20,
        border: "1px solid var(--border)",
        background: "radial-gradient(600px 380px at 50% 45%, rgba(255,255,255,0.035), transparent 70%), linear-gradient(180deg, var(--bg-1), var(--bg-0))",
        position: "relative",
        overflow: "hidden",
        boxShadow: "0 40px 80px -30px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.04)"
      }}>
        <svg viewBox="0 0 900 620" style={{ width: "100%", height: "100%", display: "block" }}>
          <defs>
            <filter id="goo-canvas" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
              <feColorMatrix in="blur" mode="matrix"
                values="1 0 0 0 0
                        0 1 0 0 0
                        0 0 1 0 0
                        0 0 0 20 -9" result="goo" />
              <feComposite in="SourceGraphic" in2="goo" operator="atop" />
            </filter>
          </defs>
          <g ref={containerRef} filter="url(#goo-canvas)" />
        </svg>
      </div>

      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)", letterSpacing: "0.04em", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a3e635", boxShadow: "0 0 8px #a3e635", display: "inline-block" }} />
        tap / click any shape · they drift and merge on their own
      </div>
    </div>
  );
}
