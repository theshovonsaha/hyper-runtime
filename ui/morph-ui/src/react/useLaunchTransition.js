import { useCallback, useRef } from "react";

/**
 * const { overlayRef, launch } = useLaunchTransition();
 * <div ref={overlayRef} className="morph-launch-overlay" />   // once, at stage root
 *
 * await launch({ fromEl, toEl, color });
 *
 * Not chat-specific — any "this thing compresses and flies to become that
 * thing" moment (a card collapsing into a toolbar icon, a form packing into
 * a status pill) can reuse this same hook. `fromEl`/`toEl` just need to
 * share a positioned ancestor that holds the overlay ref.
 */
export function useLaunchTransition() {
  const overlayRef = useRef(null);

  const launch = useCallback(({ fromEl, toEl, color = "var(--morph-accent)", duration = 520, targetSize = 56 }) => {
    return new Promise((resolve) => {
      if (!fromEl || !toEl || !overlayRef.current) {
        resolve();
        return;
      }
      const overlay = overlayRef.current;
      const stageRect = overlay.getBoundingClientRect();
      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      const ghost = document.createElement("div");
      ghost.className = "morph-launch-ghost";
      Object.assign(ghost.style, {
        position: "absolute",
        left: fromRect.left - stageRect.left + "px",
        top: fromRect.top - stageRect.top + "px",
        width: fromRect.width + "px",
        height: fromRect.height + "px",
        borderRadius: "14px",
        background: color,
        opacity: "0.9",
        transition: `left ${duration}ms cubic-bezier(.65,0,.35,1), top ${duration}ms cubic-bezier(.65,0,.35,1), width ${duration}ms cubic-bezier(.65,0,.35,1), height ${duration}ms cubic-bezier(.65,0,.35,1), opacity ${duration}ms ease`,
        willChange: "left, top, width, height, opacity",
        pointerEvents: "none",
      });
      overlay.appendChild(ghost);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const w = Math.min(targetSize, toRect.width || targetSize);
          const h = Math.min(28, toRect.height || 28);
          ghost.style.left = toRect.left - stageRect.left + toRect.width / 2 - w / 2 + "px";
          ghost.style.top = toRect.top - stageRect.top + toRect.height / 2 - h / 2 + "px";
          ghost.style.width = w + "px";
          ghost.style.height = h + "px";
          ghost.style.opacity = "0";
        });
      });

      setTimeout(() => {
        ghost.remove();
        resolve();
      }, duration + 40);
    });
  }, []);

  return { overlayRef, launch };
}

export default useLaunchTransition;
