import React, { useState } from "react";
import { classify } from "../core/adapters.js";

/**
 * <DataView value={tool.result} />
 *
 * Looks at the shape of `value`, decides what it actually is (a metric set,
 * a table of records, a tag list, a link, a big blob of text...) and renders
 * the version a human would actually want to read — falling back to raw
 * JSON only when nothing smarter applies.
 */
export function DataView({ value, label }) {
  const kind = classify(value);
  switch (kind) {
    case "image":
      return (
        <div className="morph-dv-image">
          <img src={value} alt={label || "result image"} />
        </div>
      );
    case "link":
      return (
        <a className="morph-dv-link" href={value} target="_blank" rel="noreferrer">
          {value}
        </a>
      );
    case "empty":
      return <div className="morph-dv-empty">— empty —</div>;
    case "long-text":
      return <div className="morph-code-block">{value}</div>;
    case "tag-list":
      return (
        <div className="morph-dv-taglist">
          {value.map((v, i) => (
            <span className="morph-dv-tag" key={i}>
              {String(v)}
            </span>
          ))}
        </div>
      );
    case "table":
      return <DataTable rows={value} />;
    case "stat-grid":
      return <StatGrid data={value} />;
    case "key-value":
      return <KeyValueGrid data={value} />;
    case "tree":
      return <TreeNode data={value} depth={0} />;
    case "primitive":
      return <PrimitiveValue value={value} />;
    default:
      return <div className="morph-code-block">{JSON.stringify(value, null, 2)}</div>;
  }
}

function PrimitiveValue({ value }) {
  if (typeof value === "boolean") return <span className={"morph-dv-prim bool"}>{String(value)}</span>;
  if (typeof value === "number") return <span className="morph-dv-prim num">{value}</span>;
  if (value === null || value === undefined) return <span className="morph-dv-prim null">null</span>;
  return <span className="morph-dv-prim str">"{String(value)}"</span>;
}

function DataTable({ rows }) {
  const cols = Object.keys(rows[0]);
  return (
    <div className="morph-dv-table-wrap">
      <table className="morph-dv-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>
                  <PrimitiveValue value={r[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatGrid({ data }) {
  return (
    <div className="morph-dv-statgrid">
      {Object.entries(data).map(([k, v]) => (
        <div className="morph-dv-stat" key={k}>
          <div className="morph-dv-stat-value">{v}</div>
          <div className="morph-dv-stat-label">{k}</div>
        </div>
      ))}
    </div>
  );
}

function KeyValueGrid({ data }) {
  return (
    <div className="morph-dv-kv">
      {Object.entries(data).map(([k, v]) => (
        <div className="morph-dv-kv-row" key={k}>
          <span className="morph-dv-kv-key">{k}</span>
          <PrimitiveValue value={v} />
        </div>
      ))}
    </div>
  );
}

function TreeNode({ data, depth }) {
  const [open, setOpen] = useState(depth < 1);
  const entries = Array.isArray(data) ? data.map((v, i) => [i, v]) : Object.entries(data);
  return (
    <div className="morph-dv-tree" style={{ paddingLeft: depth ? 12 : 0 }}>
      {depth > 0 && (
        <div className="morph-dv-tree-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} {Array.isArray(data) ? `[${entries.length}]` : `{${entries.length}}`}
        </div>
      )}
      {(depth === 0 || open) &&
        entries.map(([k, v]) => (
          <div className="morph-dv-tree-row" key={k}>
            <span className="morph-dv-kv-key">{k}</span>
            {typeof v === "object" && v !== null ? <TreeNode data={v} depth={depth + 1} /> : <PrimitiveValue value={v} />}
          </div>
        ))}
    </div>
  );
}

export default DataView;
