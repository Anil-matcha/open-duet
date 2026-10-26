const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MINIMUM_BYTES = 2n * 1024n ** 3n;

function nearestExistingPath(candidate, existsSync = fs.existsSync) {
  let current = path.resolve(candidate);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing path found for ${candidate}.`);
    current = parent;
  }
  return current;
}

function checkPackageSpace(paths, { statfsSync = fs.statfsSync, existsSync = fs.existsSync, tempDir = os.tmpdir() } = {}) {
  const locations = [
    paths.desktop,
    path.join(paths.desktop, "release"),
    paths.frontend,
    path.join(paths.frontend, ".next"),
    paths.ui || path.join(paths.frontend, "out"),
    paths.backend,
    path.join(paths.backend, "build"),
    path.join(paths.backend, "dist"),
    tempDir,
  ];
  for (const location of locations) {
    let checkedAt;
    let stats;
    try {
      checkedAt = nearestExistingPath(location, existsSync);
      stats = statfsSync(checkedAt, { bigint: true });
    } catch (error) {
      throw new Error(`Cannot check available disk space for ${location}: ${error.message} Free space and retry, or check that the path and filesystem are accessible.`);
    }
    const available = stats.bavail * stats.bsize;
    if (available < MINIMUM_BYTES) {
      const gib = Number(available) / (1024 ** 3);
      throw new Error(`Insufficient disk space for packaging at ${location} (checked ${checkedAt}): ${gib.toFixed(2)} GiB available; at least 2 GiB is required. Free space and retry.`);
    }
  }
}

module.exports = { MINIMUM_BYTES, checkPackageSpace };
