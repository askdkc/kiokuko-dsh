# Continuity

## What it does

Continuity adds a short summary of recent execution evidence to
`kiokuko:execution`.

- `off`: disabled (default)
- `shadow`: builds the summary without changing the model input
- `active`: replaces the recent-evidence section with the summary

## Benefits

The model can quickly see what was already read and what still needs checking.
The summary is limited by size and item count, so context growth stays bounded.

## Setup

Add the following to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: kiokuko-dsh
  config:
    continuity:
      mode: active
      maxSupplementBytes: 4096
      maxItems: 12
```

If the row already has other `config` values, keep them and add `continuity`
alongside them. The `web` profile reloads the change automatically. Check the
loaded configuration with `dsh --profile web --dump-config`.
