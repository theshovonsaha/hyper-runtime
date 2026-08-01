import React, { useEffect, useRef } from 'react';
import { shapePath } from 'morph-ui/core';

const PALETTE = [
  "#8B5CF6", // violet
  "#22D3EE", // cyan
  "#EC4899", // pink
  "#FBBF24", // amber
  "#A3E635", // lime
  "#FB7185"  // coral
];

const SHAPES = ["circle","triangle","square","pentagon","hexagon","star","blob"];

function rand(min, max) { return min + Math.random() * (max - min); }

export function GooeyBackground() {
  const containerRef = useRef(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const layer = containerRef.current;
    if (!layer) return;

    const blobs = [
      { x: 250, y: 200, type: 'blob', color: PALETTE[0], R: 85, driftX: 35, driftY: 25, speed: 0.2, phase: 0 },
      { x: 650, y: 180, type: 'hexagon', color: PALETTE[1], R: 90, driftX: 40, driftY: 30, speed: 0.18, phase: 1.2 },
      { x: 450, y: 450, type: 'star', color: PALETTE[2], R: 75, driftX: 30, driftY: 35, speed: 0.22, phase: 2.5 },
      { x: 750, y: 480, type: 'pentagon', color: PALETTE[3], R: 80, driftX: 25, driftY: 20, speed: 0.15, phase: 3.8 },
      { x: 180, y: 460, type: 'triangle', color: PALETTE[4], R: 70, driftX: 30, driftY: 28, speed: 0.25, phase: 4.5 }
    ];

    const svgNS = "http://www.w3.org/2000/svg";
    const elements = blobs.map((b, i) => {
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "blob");
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("fill", b.color);
      path.setAttribute("opacity", "0.4");
      path.setAttribute("d", shapePath(b.type, b.R, i));
      g.appendChild(path);
      layer.appendChild(g);
      return { g, path, b, seed: i };
    });

    let rafId;
    function frame(t) {
      const time = t / 1000;
      elements.forEach(({ g, b }) => {
        const dx = Math.sin(time * b.speed + b.phase) * b.driftX;
        const dy = Math.cos(time * b.speed * 1.3 + b.phase) * b.driftY;
        const x = b.x + dx;
        const y = b.y + dy;
        g.setAttribute("transform", `translate(${x.toFixed(2)}, ${y.toFixed(2)})`);
      });
      if (!reduceMotion) rafId = requestAnimationFrame(frame);
    }

    if (!reduceMotion) {
      rafId = requestAnimationFrame(frame);
    } else {
      elements.forEach(({ g, b }) => {
        g.setAttribute("transform", `translate(${b.x}, ${b.y})`);
      });
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (layer) layer.innerHTML = "";
    };
  }, []);

  return (
    <div className="blob-layer">
      <svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%' }}>
        <defs>
          <filter id="goo-bg" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="15" result="blur" />
            <feColorMatrix in="blur" mode="matrix"
              values="1 0 0 0 0
                      0 1 0 0 0
                      0 0 1 0 0
                      0 0 0 19 -8" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
        <g ref={containerRef} filter="url(#goo-bg)" />
      </svg>
    </div>
  );
}
