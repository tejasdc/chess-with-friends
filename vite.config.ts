import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Keep this in prompt mode. `autoUpdate` forces skipWaiting/client reloads
    // as soon as a new SW is available, which bypasses the active-game hold in
    // `usePwaUpdateHandling()` and can reload a player mid-move.
    VitePWA({
      // Keep public/manifest.webmanifest authoritative, including portrait orientation.
      manifest: false,
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      injectRegister: false,
      registerType: "prompt",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,webmanifest,png,svg}"],
        minify: false,
      },
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
