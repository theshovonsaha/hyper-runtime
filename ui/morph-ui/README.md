# morph-ui

A small system for shape-morphing interfaces: an extensible SVG shape engine,
generic React primitives for building panel-based UIs that resize and slide
between views, and an optional chat kit built on top of them.

```
npm install morph-ui lucide-react
```

```jsx
import "morph-ui/styles.css";
import { BlobAvatar, MorphPanel, useViewStack } from "morph-ui/react";
```

## Layers

- **`morph-ui` / `morph-ui/core`** — framework-agnostic. `buildPoints`,
  `catmullRom2bezier`, `shapePath`, and a `SHAPE_REGISTRY` you can extend.
- **`morph-ui/react`** — `<MorphShape>`, `<BlobAvatar>`, `<MorphPanel>`,
  `useViewStack()`. Generic — nothing here knows what "chat" is.
- **`morph-ui/chatkit`** — `<MessageBubble>`, `<ToolChip>`, `<ToolDetailView>`,
  `<HistoryView>`. Opinionated, built entirely from the layer above. Skip this
  import if you're building something else on top of the primitives.
- **`morph-ui/styles.css`** — one stylesheet, themed via CSS custom
  properties (`--morph-accent`, `--morph-bg`, etc). Import once, override on
  any parent element.

## Adding a shape

Shapes are just `(theta, R, seed) => radius` functions:

```js
import { registerShape } from "morph-ui/core";

registerShape("diamond", (theta, R) => {
  const a = Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta));
  return R / a;
});
```

Every `<MorphShape type="diamond">` and any `<BlobAvatar>` preset that
references it now works — no other code changes.

## Building a panel-based UI (not chat)

`MorphPanel` + `useViewStack` are the two pieces worth reaching for on their
own — a settings modal, a command palette, an onboarding flow:

```jsx
const { current, push, pop, direction } = useViewStack({ key: "main" });

<MorphPanel viewKey={current.key} direction={direction}>
  {current.key === "main" && <MainView onNext={() => push({ key: "detail" })} />}
  {current.key === "detail" && <DetailView onBack={pop} />}
</MorphPanel>
```

The panel measures its content and animates `height` on every swap, and the
incoming view slides in from the direction implied by push/pop — the same
mechanism the chat modal uses to grow into a tool-call view and shrink back.

## Theming

Override tokens on any ancestor:

```css
.my-app {
  --morph-accent: #ff5470;
  --morph-radius: 14px;
  --morph-font: 'Inter', sans-serif;
}
```

See `example/ChatDemo.jsx` for a full app assembled from these pieces.
