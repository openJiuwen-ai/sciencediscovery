import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The site is hosted under a prefix (`/site/` on the OBS bucket). Asset and
// catalog URLs must use the same base, so the exporter reads HUB_BASE_PATH too.
export default defineConfig({
  base: process.env.HUB_BASE_PATH ?? "/",
  // A service-hosted build ships no exporter output: the API serves the
  // catalogue and the files, so `public/` must not be copied into `dist/`.
  publicDir: process.env.HUB_PUBLIC_DIR === "none" ? false : "public",
  plugins: [react()],
});
