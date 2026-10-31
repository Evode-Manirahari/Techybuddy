import type { NextConfig } from "next";

const config: NextConfig = {
  // The dev server treats `localhost` as its own host. Without this entry, opening the app at
  // http://127.0.0.1:3000 blocks client chunks as cross-origin, so the page never hydrates.
  allowedDevOrigins: ["127.0.0.1"],
};

export default config;
