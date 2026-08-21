import React from "react";
import { MorphShape } from "./MorphShape.jsx";

/** Default status -> {shape, color, animate, speed} mapping. Override or extend
 * by passing your own `presets` prop — merged over these defaults. */
export const DEFAULT_STATUS_PRESETS = {
  idle:    { shape: "circle",   color: "#8B5CF6", animate: true, speed: 0.15 },
  running: { shape: "blob",     color: "#22D3EE", animate: true, speed: 0.9 },
  success: { shape: "hexagon",  color: "#A3E635", animate: true, speed: 0.1 },
  error:   { shape: "star",     color: "#FB7185", animate: true, speed: 0.1 },
  history: { shape: "pentagon", color: "#FBBF24", animate: true, speed: 0.1 },
};

/**
 * <BlobAvatar state="running" size={40} />
 * Swap the mapping per-app: <BlobAvatar state="warn" presets={{ warn: {...} }} />
 */
export function BlobAvatar({ state = "idle", size = 40, presets = {}, className = "" }) {
  const merged = { ...DEFAULT_STATUS_PRESETS, ...presets };
  const cfg = merged[state] || merged.idle;
  return (
    <MorphShape
      type={cfg.shape}
      color={cfg.color}
      animate={cfg.animate}
      speed={cfg.speed}
      size={size}
      className={"morph-avatar " + className}
    />
  );
}

export default BlobAvatar;
