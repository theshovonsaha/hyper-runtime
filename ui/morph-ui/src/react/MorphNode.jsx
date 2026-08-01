import React, { useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { MorphShape } from "./MorphShape.jsx";
import { MorphPanel } from "./MorphPanel.jsx";

/**
 * The core idea: a node is EITHER
 *   - collapsed: rendered by whatever "kind" it is (an orb, a tile, a tool
 *     chip, a plain message — see NODE_KIND_RENDERERS)
 *   - expanded: a header + a list of its children, each of which is a
 *     <MorphNode> too, and therefore follows this exact same rule again.
 *
 * There's no fixed depth. A tool call, a chat-history section, and the
 * whole turn are the same kind of thing at different scales — click any of
 * them and it does the same collapsed -> expanded flip its parent did.
 *
 * The outer container's own shape changes between the two states
 * (`.morph-outer-square` <-> `.morph-outer-round`) so the transformation
 * reads as "this thing became a different kind of shape," not just
 * "content changed."
 */

export const NODE_KIND_RENDERERS = {};

export function registerNodeKind(name, Component) {
  NODE_KIND_RENDERERS[name] = Component;
}

export function MorphNode({ node, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const canExpand = hasChildren || typeof node.renderExpanded === "function";
  const Summary = NODE_KIND_RENDERERS[node.kind] || NODE_KIND_RENDERERS.tile;

  return (
    <div className={"morph-node " + (expanded ? "morph-outer-round" : "morph-outer-square")}>
      <MorphPanel viewKey={node.id + (expanded ? ":open" : ":closed")} direction={expanded ? 1 : -1}>
        {!expanded ? (
          <Summary node={node} canExpand={canExpand} onClick={() => canExpand && setExpanded(true)} />
        ) : (
          <div className="morph-node-expanded">
            <div className="morph-node-header">
              <button className="morph-node-collapse" onClick={() => setExpanded(false)} aria-label="Collapse">
                <ArrowLeft size={13} />
              </button>
              <span>{node.label}</span>
            </div>
            <div className="morph-node-children">
              {hasChildren
                ? node.children.map((child) => <MorphNode key={child.id} node={child} />)
                : node.renderExpanded()}
            </div>
          </div>
        )}
      </MorphPanel>
    </div>
  );
}

/* ---- default kinds (extend with registerNodeKind) --------------------- */

function OrbSummary({ node, canExpand, onClick }) {
  return (
    <div className={"morph-node-orb " + (node.status || "")} onClick={onClick} role={canExpand ? "button" : undefined}>
      <MorphShape type={node.shape || "blob"} color={node.color || "#22D3EE"} size={22} animate={node.status === "running"} speed={0.9} />
      <div className="morph-node-orb-text">
        <span className="morph-node-orb-hint">{node.hint}</span>
      </div>
      {canExpand && <ChevronRight size={13} className="morph-chip-arrow" />}
    </div>
  );
}

function TileSummary({ node, canExpand, onClick }) {
  return (
    <div className={"morph-node-tile" + (canExpand ? " clickable" : "")} onClick={onClick} role={canExpand ? "button" : undefined}>
      <span className={"morph-node-tile-dot " + (node.status || "")} />
      <div className="morph-node-tile-text">
        <span className="morph-node-tile-label">{node.label}</span>
        {node.meta && <span className="morph-node-tile-meta">{node.meta}</span>}
      </div>
      {canExpand && <ChevronRight size={13} className="morph-chip-arrow" />}
    </div>
  );
}

function MessageSummary({ node }) {
  return <div className={"morph-bubble " + node.role}>{node.content}</div>;
}

registerNodeKind("orb", OrbSummary);
registerNodeKind("tile", TileSummary);
registerNodeKind("message", MessageSummary);

export default MorphNode;
