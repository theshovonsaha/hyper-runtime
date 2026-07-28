# Contributing

Hyper-Runtime welcomes small, falsifiable improvements.

Before opening a change:

1. identify the failure mode;
2. add or update a versioned fixture with the expected result;
3. state which experimental condition should change and which should not;
4. implement through public package boundaries;
5. run `bun run check`; and
6. document limitations and incompatible changes.

Do not add a feature to the default runtime solely because it is reachable or
interesting. A new capability needs a manifest, target policy, risk ceiling,
approval rule, idempotency behavior, observation, verifier, and failure tests.

Do not weaken an acceptance threshold after viewing a failure unless the metric
definition itself was demonstrably invalid. Record that decision in the
research protocol.

Legacy code under `src/` may be migrated only through a public contract. New
packages must not import legacy modules.
