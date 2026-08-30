# Third-party notices

The Planrock dashboard production bundle includes Mantine, React, Floating UI,
clsx, tslib, and supporting React scroll/focus utilities. The exact package
inventory, versions, SPDX identifiers, and corresponding retained license
files are recorded in `LICENSES/production-bundle.json`.

The production build emits `dist/dashboard/dependency-inventory.json` from the
actual Vite module graph. Package validation requires that generated inventory
to match the licensed manifest exactly and verifies every recorded version,
SPDX identifier, and included license file before a tarball can pass.
