---
name: schema-migration
description: Apply a schema migration in this repository: read the previous migration, write the new one, then run the migration test before touching application code.
---

# Schema migration

## When this applies

A change adds or alters a table, or a test fails with a missing column.

## Order

1. Read the newest file under `db/migrations/` so the naming and the down-migration shape match.
2. Write the new migration, including the `down` step.
3. Run the migration test on its own before changing any application code.
4. Only then edit the queries that depend on the new shape.

## Caveat

Step 3 is the one that gets skipped. If the migration test cannot run alone, fix that first; running it through the full suite hides which migration failed.
