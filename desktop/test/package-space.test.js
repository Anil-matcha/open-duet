const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { MINIMUM_BYTES, checkPackageSpace } = require("../src/package-space");

const fixtureRoot = path.resolve(os.tmpdir(), "od-package-space-fixture");
const paths = {
  desktop: path.join(fixtureRoot, "desktop"),
  frontend: path.join(fixtureRoot, "frontend"),
  ui: path.join(fixtureRoot, "frontend", "out"),
  backend: path.join(fixtureRoot, "backend"),
};
const tempDir = path.join(fixtureRoot, "tmp");
const enough = { bsize: 4096n, bavail: MINIMUM_BYTES / 4096n, bfree: 0n };

test("accepts exactly the 2 GiB operational minimum using bavail", () => {
  const seen = [];
  checkPackageSpace(paths, {
    statfsSync: (location, options) => { seen.push([location, options]); return enough; },
    existsSync: () => true,
    tempDir,
  });
  assert.deepEqual(seen.map(([location]) => location), [
    paths.desktop,
    path.join(paths.desktop, "release"),
    paths.frontend,
    path.join(paths.frontend, ".next"),
    paths.ui,
    paths.backend,
    path.join(paths.backend, "build"),
    path.join(paths.backend, "dist"),
    tempDir,
  ]);
  assert.ok(seen.every(([, options]) => options.bigint === true));
});

test("rejects space below the minimum", () => {
  assert.throws(() => checkPackageSpace(paths, {
    statfsSync: () => ({ bsize: 4096n, bavail: MINIMUM_BYTES / 4096n - 1n, bfree: MINIMUM_BYTES }),
    existsSync: () => true,
    tempDir,
  }), /Insufficient disk space.*at least 2 GiB is required.*Free space and retry/);
});

test("uses the nearest existing ancestor and reports stat failures clearly", () => {
  const checked = [];
  const volumeRoot = path.parse(fixtureRoot).root;
  checkPackageSpace(paths, {
    existsSync: (location) => location === volumeRoot,
    statfsSync: (location) => { checked.push(location); return enough; },
    tempDir,
  });
  assert.equal(checked.length, 9);
  assert.ok(checked.every((location) => location === volumeRoot));

  assert.throws(() => checkPackageSpace(paths, {
    statfsSync: () => { throw new Error("permission denied"); },
    existsSync: () => true,
    tempDir,
  }), (error) => error.message.startsWith(`Cannot check available disk space for ${paths.desktop}: permission denied`)
    && error.message.includes("accessible"));
});

test("checks later output and temporary directories even when earlier locations are adequate", () => {
  for (const failingIndex of [1, 2, 3, 4, 5, 6, 7, 8]) {
    let index = 0;
    assert.throws(() => checkPackageSpace(paths, {
      statfsSync: () => index++ === failingIndex
        ? { bsize: 4096n, bavail: 1n, bfree: MINIMUM_BYTES }
        : enough,
      existsSync: () => true,
      tempDir,
    }), /Insufficient disk space/);
    assert.equal(index, failingIndex + 1);
  }
});

test("packaging checks space before starting any build subprocess", () => {
  const preload = `
    const fs = require("node:fs");
    const child = require("node:child_process");
    fs.statfsSync = () => ({ bsize: 4096n, bavail: 1n, bfree: 999999999999n });
    fs.existsSync = () => true;
    child.spawnSync = () => { throw new Error("build subprocess started"); };
  `;
  const result = spawnSync(process.execPath, ["-e", `${preload}\nrequire(${JSON.stringify(path.resolve(__dirname, "../scripts/package.js"))})`], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Insufficient disk space/);
  assert.doesNotMatch(result.stderr, /build subprocess started/);
});
