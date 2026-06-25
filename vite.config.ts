import { defineConfig } from "vite";

// SharedArrayBuffer (and Atomics.wait in workers) is only exposed to a page that
// is "cross-origin isolated", which requires these two response headers on the
// document. We set them for both `vite dev` and `vite preview`. Without them the
// game still runs — it just falls back to the single-threaded AI path (see
// src/parallel/caps.ts). For a PRODUCTION static deploy, whatever serves dist/
// must send the same two headers (see public/_headers for Netlify/Cloudflare; for
// nginx use add_header; GitHub Pages can't set headers and needs a SW shim).
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: "es" },
});
