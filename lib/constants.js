const os = require("node:os");
const path = require("node:path");

const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];
const STORAGE_DIR = path.join(os.homedir(), ".agents", "planrock");

module.exports = {
  CONTROL_PROTOCOL_VERSION: 1,
  DEFAULT_PORT: 4210,
  INDEX_SCHEMA_VERSION: 1,
  LIMITS: {
    aggregateMilliseconds: 120_000,
    aggregatePlanBytes: 256 * 1024 * 1024,
    aggregatePlanCandidates: 50_000,
    diagnosticBytes: 4 * 1024,
    excerptBytes: 8 * 1024,
    indexReadBytes: 64 * 1024 * 1024,
    indexWriteBytes: 48 * 1024 * 1024,
    maxDepth: 4,
    maxDirectories: 5_000,
    maxProjects: 256,
    pathBytes: 32 * 1024,
    planBytes: 2 * 1024 * 1024,
    registryReadBytes: 8 * 1024 * 1024,
    registryWriteBytes: 6 * 1024 * 1024,
    rootMilliseconds: 15_000,
    rootPlanBytes: 64 * 1024 * 1024,
    rootPlanCandidates: 10_000,
    taskchefBytes: 16 * 1024 * 1024,
    titleBytes: 1024,
  },
  PRIORITIES,
  REGISTRY_SCHEMA_VERSION: 1,
  STORAGE_DIR,
};
