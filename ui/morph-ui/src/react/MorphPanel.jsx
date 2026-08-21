import React, { useLayoutEffect, useRef, useState } from "react";

/**
 * <MorphPanel viewKey={current.key} direction={dir}>
 *   {...whatever view is active...}
 * </MorphPanel>
 *
 * Not chat-specific. Any time you swap content and want the container to
 * resize + the new content to slide/fade in, this is the piece to reach for —
 * a settings modal, a command palette, an onboarding flow, etc.
 *
 * direction: 1 = forward (slides in from right), -1 = back (slides in from left)
 */
export function MorphPanel({ viewKey, direction = 1, children, className = "" }) {
  const measureRef = useRef(null);
  const [height, setHeight] = useState(null);

  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const el = measureRef.current;
    const ro = new ResizeObserver(() => setHeight(el.scrollHeight));
    ro.observe(el);
    setHeight(el.scrollHeight);
    return () => ro.disconnect();
  }, [viewKey]);

  return (
    <div className={"morph-panel-outer " + className} style={{ height: height != null ? height : "auto" }}>
      <div className="morph-panel-inner" ref={measureRef}>
        <div key={viewKey} className={"morph-panel-view" + (direction < 0 ? " back" : "")}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default MorphPanel;
