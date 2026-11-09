import { defineConfig } from "vite";

// Fixed dev port; strictPort: never walk to a neighbour's port.
export default defineConfig({
  clearScreen: false,
  server: { port: 4830, strictPort: true, host: "127.0.0.1", watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
