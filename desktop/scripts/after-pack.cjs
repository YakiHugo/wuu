const { verifyResources } = require("./packaged-runtime-smoke.cjs");

module.exports = async function afterPack(context) {
  // Verify runtime payloads before signing without changing historical launchers.
  verifyResources(context.packager.getResourcesDir(context.appOutDir));
};
