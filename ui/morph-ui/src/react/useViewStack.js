import { useCallback, useState } from "react";

/**
 * useViewStack({ type: 'chat' })
 *
 * Generic push/pop navigation for panel-based UIs. `current` is whatever
 * object you pushed (e.g. { type: 'tool', toolId }) — the hook doesn't care
 * about shape, it just tracks the stack + which direction the last move was,
 * so MorphPanel knows whether to slide in from the left or right.
 */
export function useViewStack(initial) {
  const [stack, setStack] = useState([initial]);
  const [direction, setDirection] = useState(1);

  const push = useCallback((view) => {
    setDirection(1);
    setStack((s) => [...s, view]);
  }, []);

  const pop = useCallback(() => {
    setDirection(-1);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const reset = useCallback((view) => {
    setDirection(-1);
    setStack([view]);
  }, []);

  const replace = useCallback((view) => {
    setDirection(1);
    setStack((s) => [...s.slice(0, -1), view]);
  }, []);

  return {
    stack,
    current: stack[stack.length - 1],
    depth: stack.length,
    direction,
    push,
    pop,
    reset,
    replace,
  };
}

export default useViewStack;
