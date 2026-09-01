# Kiokuko sample database

`kiokuko.sqlite3` is a deterministic, synthetic CI fixture. It contains:

- project-scoped memory entries, including Unicode and multiline text;
- global memory entries;
- one imported external-skill snapshot and its entry mappings.

The fixture intentionally stops at schema version 11. CI copies it into an
isolated application-data directory before running `kiokuko setup`, so the
committed file is never migrated in place. The test then runs `kiokuko doctor`
and checks the migrated data through a real `kiokuko web` process.

Regenerate it after intentionally changing the fixture or its baseline:

```sh
npm run sampledb:generate
```

Do not run `kiokuko setup` or `kiokuko web` directly against the committed
fixture. Use `npm run test:sampledb`, which works on a temporary copy.
