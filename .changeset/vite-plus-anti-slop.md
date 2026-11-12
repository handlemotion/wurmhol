---
"wurmhol": patch
---

Local state files, logs and server answers are now checked when read: a malformed share file is removed instead of half-trusted, and a non-JSON success answer from a proxy or portal page fails with an error naming it instead of returning nothing.
