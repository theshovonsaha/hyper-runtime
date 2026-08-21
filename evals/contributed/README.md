# Independent fixture contribution

Copy `template.v1.json`, replace every scenario, and submit it without viewing
Hyper-Runtime's treatment results. Set `authorship.kind` to `independent`, name
the contributor, state conflicts, and choose a compatible open license.

Run:

```bash
HYPER_CONTRIBUTED_EVAL=evals/contributed/your-fixture.json bun run eval:contributed
```

The report records the source-file SHA-256, contributor, full treatment trials,
and the authorization-only baseline. Project-authored fixtures must not use the
`independently_contributed_fixture` evidence label.
