import { resolve } from "path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: { externalizeDeps: true },
  },
  preload: {
    build: { externalizeDeps: true },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          panel: resolve(__dirname, "src/renderer/panel.html"),
        },
      },
    },
  },
});
