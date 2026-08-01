/**
 * morph-ui/core adapters — decide how a piece of data *should* look before
 * any React component touches it. Same extensibility pattern as shapes.js:
 * register a test, get a `kind` back, React maps kind -> a renderer.
 */

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function sameKeys(objs) {
  if (objs.length === 0) return false;
  const first = Object.keys(objs[0]).sort().join("|");
  return objs.every((o) => Object.keys(o).sort().join("|") === first);
}

/** Ordered highest-priority-first. First matching test wins. */
export const DATA_ADAPTERS = [];

export function registerAdapter({ name, test, priority = 0 }) {
  DATA_ADAPTERS.push({ name, test, priority });
  DATA_ADAPTERS.sort((a, b) => b.priority - a.priority);
}

export function classify(value) {
  for (const adapter of DATA_ADAPTERS) {
    try {
      if (adapter.test(value)) return adapter.name;
    } catch {
      /* a bad test shouldn't crash rendering */
    }
  }
  return "raw";
}

// --- defaults, highest priority first --------------------------------
registerAdapter({
  name: "image",
  priority: 100,
  test: (v) => typeof v === "string" && /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i.test(v),
});
registerAdapter({
  name: "link",
  priority: 90,
  test: (v) => typeof v === "string" && /^https?:\/\//.test(v),
});
registerAdapter({
  name: "empty",
  priority: 80,
  test: (v) =>
    v === null ||
    v === undefined ||
    (Array.isArray(v) && v.length === 0) ||
    (isPlainObject(v) && Object.keys(v).length === 0) ||
    v === "",
});
registerAdapter({
  name: "long-text",
  priority: 70,
  test: (v) => typeof v === "string" && v.length > 140,
});
registerAdapter({
  name: "tag-list",
  priority: 60,
  test: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x !== "object" || x === null),
});
registerAdapter({
  name: "table",
  priority: 50,
  test: (v) => Array.isArray(v) && v.length > 0 && v.every(isPlainObject) && sameKeys(v),
});
registerAdapter({
  name: "stat-grid",
  priority: 40,
  test: (v) =>
    isPlainObject(v) &&
    Object.keys(v).length > 0 &&
    Object.keys(v).length <= 6 &&
    Object.values(v).every((x) => typeof x === "number"),
});
registerAdapter({
  name: "key-value",
  priority: 30,
  test: (v) => isPlainObject(v) && Object.values(v).every((x) => typeof x !== "object" || x === null),
});
registerAdapter({
  name: "tree",
  priority: 20,
  test: (v) => isPlainObject(v) || Array.isArray(v),
});
registerAdapter({
  name: "primitive",
  priority: 10,
  test: (v) => typeof v !== "object" || v === null,
});
