const { parentPort } = require("node:worker_threads");
const { refreshIndex } = require("./indexer");

(async () => {
  try {
    const testDelay = process.env.PLANROCK_SERVER_TESTS === "1" ? Number(process.env.PLANROCK_TEST_REFRESH_DELAY_MS) || 0 : 0;
    if (testDelay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(testDelay, 10_000)));
    refreshIndex({ trigger: process.env.PLANROCK_REFRESH_TRIGGER || "dashboard" });
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({ ok: false, message: "Bounded refresh failed" });
  }
})();
