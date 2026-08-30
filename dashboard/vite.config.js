const path = require("node:path");
const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");

function stripGeneratedTrailingWhitespace() {
  return { name: "strip-generated-trailing-whitespace", generateBundle(_options, bundle) { for (const output of Object.values(bundle)) { if (output.type === "chunk") output.code = output.code.replace(/[ \t]+$/gm, ""); } } };
}

function emitProductionDependencyInventory() {
  return { name: "emit-production-dependency-inventory", generateBundle(_options, bundle) { const packages = new Set(); for (const output of Object.values(bundle)) { if (output.type !== "chunk") continue; for (const moduleId of Object.keys(output.modules)) { const marker = `${path.sep}node_modules${path.sep}`; const offset = moduleId.lastIndexOf(marker); if (offset === -1) continue; const parts = moduleId.slice(offset + marker.length).split(path.sep); packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]); } } this.emitFile({ type: "asset", fileName: "dependency-inventory.json", source: `${JSON.stringify({ schemaVersion: 1, packages: [...packages].sort() }, null, 2)}\n` }); } };
}

module.exports = defineConfig({
  root: __dirname,
  base: "/",
  plugins: [react.default(), stripGeneratedTrailingWhitespace(), emitProductionDependencyInventory()],
  build: {
    target: ["es2022"],
    outDir: path.resolve(__dirname, "..", "dist", "dashboard"),
    emptyOutDir: true,
  },
  test: { environment: "jsdom", setupFiles: [path.resolve(__dirname, "src", "test-setup.js")] },
});
