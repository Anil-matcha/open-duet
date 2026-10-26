import type { NextConfig } from "next";

// A deployment that serves the app under a prefix (for example /app, with another site at /)
// sets OD_BASE_PATH when it builds. Empty, the default, leaves every build exactly as it was.
const basePath = process.env.OD_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  // Set only when building the files the desktop app serves itself: the page is
  // plain client-side code, so it exports to static files in `out/`. A trailing
  // slash makes `/chat` the folder `chat/index.html`, which a plain file server
  // (the backend's) can serve; without it `/chat` would be a 404.
  ...(process.env.OD_STATIC_EXPORT === "1"
    ? { output: "export" as const, trailingSlash: true }
    : {}),
};

export default nextConfig;
