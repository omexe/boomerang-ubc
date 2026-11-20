// The app is plain files once built: no server of its own, no rewrite rules (routes live in the
// address bar's hash), and relative asset paths so it can be served from any folder.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "es2023", sourcemap: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
