#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-package-"));
const prefix = path.join(temporary, "prefix");
const home = path.join(temporary, "home");
const workspace = path.join(temporary, "workspace");
fs.mkdirSync(path.join(workspace, "plans"), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(workspace, "plans", "package.md"), "---\ntitle: Package smoke\nstate: open\ncreated_at: 2026-08-30\n---\n\n## Goal\n\nVerify the package.\n");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, npm_config_cache: path.join(temporary, "npm-cache"), ...options.env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "dashboard/vite.config.js"]);
const inventory = JSON.parse(fs.readFileSync(path.join(root, "dist", "dashboard", "dependency-inventory.json"), "utf8"));
const licensed = JSON.parse(fs.readFileSync(path.join(root, "LICENSES", "production-bundle.json"), "utf8"));
assert.equal(inventory.schemaVersion, 1); assert.equal(licensed.schemaVersion, 1); assert.deepEqual(inventory.packages, Object.keys(licensed.packages).sort(), "production dependency inventory must exactly match the licensed manifest");
for (const [name, expected] of Object.entries(licensed.packages)) { const metadata = require(path.join(root, "node_modules", name, "package.json")); assert.equal(metadata.version, expected.version, `${name} licensed version drifted`); assert.equal(metadata.license, expected.license, `${name} license identifier drifted`); assert.equal(fs.existsSync(path.join(root, expected.licenseFile)), true, `${name} license file is missing`); }
const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary]));
assert.equal(packed.length, 1);
const tarball = path.join(temporary, packed[0].filename);
for (const required of ["lib/indexer.js", "scripts/planrock", "SKILL.md", "skills/planrock-bootstrap/SKILL.md", "skills/planrock-dashboard/SKILL.md", "dist/dashboard/index.html", "dist/dashboard/dependency-inventory.json", ...new Set(Object.values(licensed.packages).map((entry) => entry.licenseFile)), "LICENSES/production-bundle.json", "THIRD_PARTY_NOTICES.md"]) assert.ok(packed[0].files.some((file) => file.path === required), `missing ${required}`);
run("npm", ["install", "--ignore-scripts", "--prefix", prefix, tarball]);
const cli = path.join(prefix, "node_modules", ".bin", "planrock");
const local = JSON.parse(run(cli, ["status", "--working-dir", workspace, "--json"])); assert.equal(local.summary.open, 1);
run(cli, ["project", "add", workspace, "--name", "package-smoke"]);
const overview = JSON.parse(run(cli, ["overview", "--json"])); assert.equal(overview.summary.open, 1);
const port = 43000 + Math.floor(Math.random() * 1000);
const started = JSON.parse(run(cli, ["dashboard", "start", "--port", String(port), "--json"])); assert.equal(started.owner.port, port);

function get(pathname) { return new Promise((resolve, reject) => { const request = http.get({ host: "127.0.0.1", port, path: pathname, headers: { Host: `127.0.0.1:${port}` } }, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers })); }); request.on("error", reject); }); }

(async () => {
  try {
    const html = await get("/"); assert.equal(html.status, 200); assert.match(html.body, /<title>Planrock<\/title>/); assert.match(html.headers["content-security-policy"], /default-src 'self'/);
    const assets = [...html.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]); assert.ok(assets.length >= 2, "packaged dashboard HTML must reference local script and style assets");
    for (const asset of assets) assert.equal((await get(asset)).status, 200, `packaged dashboard asset failed: ${asset}`);
    const health = await get("/api/health"); assert.equal(health.status, 200); assert.equal(JSON.parse(health.body).service, "planrock"); assert.equal(health.headers["access-control-allow-origin"], undefined);
  } finally { run(cli, ["dashboard", "stop", "--port", String(port)]); }
  process.stdout.write(`Validated ${packed[0].filename} (${packed[0].size} bytes) from an installed prefix.\n`);
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
