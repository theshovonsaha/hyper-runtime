import React, { forwardRef } from "react";
import { Send } from "lucide-react";

/**
 * <MorphInputDock ref={dockRef} value={input} onChange={setInput} onSubmit={send} launching={sending} />
 *
 * Deliberately dumb: it doesn't know about turns, tools, or transitions.
 * The parent owns useLaunchTransition and decides what "sending" means.
 * `launching` just triggers the pack-down visual while the ghost flies.
 */
export const MorphInputDock = forwardRef(function MorphInputDock(
  { value, onChange, onSubmit, placeholder = "Ask something…", launching = false },
  ref
) {
  return (
    <div ref={ref} className={"morph-input-dock" + (launching ? " launching" : "")}>
      <input
        className="morph-input"
        value={value}
        placeholder={placeholder}
        disabled={launching}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim() && !launching) onSubmit();
        }}
      />
      <button className="morph-send" onClick={onSubmit} disabled={launching || !value.trim()} aria-label="Send">
        <Send size={15} />
      </button>
    </div>
  );
});

export default MorphInputDock;
