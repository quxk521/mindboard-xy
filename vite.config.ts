import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5177,
    strictPort: false
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true
  }
});
