---
name: planrock-bootstrap
description: Initialize, validate, repair, and refresh Planrock's cross-project registry and index. Use when adding, removing, relinking, importing, listing, or diagnosing Planrock project roots, or when setting up ~/.agents/planrock.
---

# Planrock Bootstrap

Use the public Planrock CLI bundled with this skill repository. Planrock owns
only `~/.agents/planrock`; never create a storage override or use TaskChef as a
runtime dependency.

## Registry workflow

Run the CLI through the installed Planrock skill repository when a global
`planrock` binary is unavailable:

```bash
node <planrock-repository>/scripts/planrock project list --json
node <planrock-repository>/scripts/planrock project add <root> --name <name> --json
node <planrock-repository>/scripts/planrock project relink <id-or-name> <new-root> --json
node <planrock-repository>/scripts/planrock project remove <id-or-name> --json
node <planrock-repository>/scripts/planrock project validate --json
node <planrock-repository>/scripts/planrock refresh --json
```

Planrock automatically inspects the fixed optional
`~/.agents/taskchef/taskchef.json` schema-2 source during refresh. Use
`project import taskchef --json` only for a forced diagnostic import.

The schema-version-2 registry has one top-level `ignore` array. Relative
entries extend built-in directory pruning; canonical absolute entries exclude
only that exact project root from automatic import and scanning. Removing a
TaskChef-imported root adds its absolute exclusion, while explicit add or
relink removes that exact exclusion. Report canonicalization, unavailable
roots, ignore validation, latest-attempt failures, scan limits, and incomplete
snapshots to the user. Do not edit repository-local plan files as part of
registry repair.
