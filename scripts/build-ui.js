// Build the web pages as plain files that the backend serves itself.
//
//   node scripts/build-ui.js                    # frontend/out, for `python -m app.server` and the desktop app
//   node scripts/build-ui.js --frontend ../x    # another checkout of the frontend
//   OD_BASE_PATH=/app node scripts/build-ui.js  # pages meant to be served under /app (or --base-path /app)
//
// One recipe for every way of serving the pages: the pages are exported as static
// files and talk to the server they were loaded from, so the same build works on any
// host name, port or reverse proxy. It installs nothing; the frontend's dependencies
// must be there already (`npm ci` in frontend/). Needs only Node, no other packages.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// What a server install needs: the sign-in and pairing pages as well as the app itself.
const SERVER_PAGES = [
  "index.html",
  path.join("chat", "index.html"),
  path.join("settings", "index.html"),
  path.join("login", "index.html"),
  path.join("pair", "index.html"),
];

class UiBuildError extends Error {}

// Throws UiBuildError (its message says what to do) if the pages cannot be built.
// `basePath` (for example "/app") builds the pages to be served under that prefix; empty is the
// unchanged build. The export has no prefix folder: only the links inside the pages carry it.
function normalizeBasePath(value) {
  const trimmed = (value || "").trim().replace(/^\/+|\/+$/g, "");
  if (trimmed && !/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) {
    throw new UiBuildError("The base path must be plain path segments, like /app.");
  }
  return trimmed ? `/${trimmed}` : "";
}

function buildUi({ frontend, out = path.join(frontend, "out"), pages = SERVER_PAGES, log = console.log, basePath = process.env.OD_BASE_PATH || "" } = {}) {
  basePath = normalizeBasePath(basePath);
  const next = path.join(frontend, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(next)) {
    throw new UiBuildError(`The page's dependencies are not installed in ${frontend}. Run \`npm ci\` there first.`);
  }

  fs.rmSync(out, { recursive: true, force: true }); // only ever this build's own output

  log("==> Building the page (static export)");
  // Turbopack's CSS worker cannot bind in this build environment; use webpack for the shared static export.
  const result = spawnSync(process.execPath, [next, "build", "--webpack"], {
    cwd: frontend,
    stdio: "inherit",
    env: {
      ...process.env,
      // Export plain files, and make the page talk to the server it was loaded from,
      // whatever port that turns out to be.
      OD_STATIC_EXPORT: "1",
      NEXT_PUBLIC_API_BASE_URL: "/api/v1",
      OD_BASE_PATH: basePath,
    },
  });
  if (result.error || result.status !== 0) throw new UiBuildError("The page did not build.");

  for (const page of pages) {
    if (!fs.existsSync(path.join(out, page))) {
      throw new UiBuildError(`The build finished but ${page} is missing from ${out}.`);
    }
  }
  if (basePath) {
    // Pages must point at their own prefix, or they load nothing when served under it.
    const home = fs.readFileSync(path.join(out, "index.html"), "utf8");
    if (!home.includes(`${basePath}/_next/`)) {
      throw new UiBuildError(`The build finished but its pages do not use the ${basePath} prefix. Check frontend/next.config.ts.`);
    }
  }
  return out;
}

function main(argv) {
  let frontend = path.resolve(__dirname, "..", "frontend");
  const flag = argv.indexOf("--frontend");
  if (flag !== -1) {
    if (!argv[flag + 1]) {
      console.error("--frontend needs a folder.");
      return 2;
    }
    frontend = path.resolve(argv[flag + 1]);
  }
  let basePath = process.env.OD_BASE_PATH || "";
  const baseFlag = argv.indexOf("--base-path");
  if (baseFlag !== -1) {
    if (!argv[baseFlag + 1]) {
      console.error("--base-path needs a path like /app.");
      return 2;
    }
    basePath = argv[baseFlag + 1];
  }
  try {
    const out = buildUi({ frontend, basePath });
    console.log(`\nBuilt ${out}\nServe it with: OPEN_DOTS_UI_DIR=${out} python -m app.server`);
    return 0;
  } catch (error) {
    if (!(error instanceof UiBuildError)) throw error;
    console.error(`\n${error.message}`);
    return 1;
  }
}

module.exports = { buildUi, normalizeBasePath, SERVER_PAGES, UiBuildError };

if (require.main === module) process.exit(main(process.argv.slice(2)));
