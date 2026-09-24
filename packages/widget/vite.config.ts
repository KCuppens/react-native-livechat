import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// React code from @kobecuppens/livechat-react runs on Preact (≈4 KB) to keep the embed small.
// Aliases are exact-match and absolute so every importer (incl. the prebuilt SDK) shares one copy.
// import.meta.resolve picks the ESM builds, matching what `import "preact"` resolves to (require.resolve
// would pick CJS and ship two Preact copies whose hooks don't share state).
const esm = (id: string) => fileURLToPath(import.meta.resolve(id));
const alias = [
  { find: /^react$/, replacement: esm("preact/compat") },
  { find: /^react-dom$/, replacement: esm("preact/compat") },
  { find: /^react-dom\/client$/, replacement: esm("preact/compat/client") },
  { find: /^react\/jsx-runtime$/, replacement: esm("preact/jsx-runtime") },
  { find: /^react\/jsx-dev-runtime$/, replacement: esm("preact/jsx-runtime") },
];

export default defineConfig({
  resolve: { alias },
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    lib: { entry: "src/index.tsx", name: "LiveChatWidget", formats: ["iife"], fileName: () => "widget.js" },
    target: "es2019",
    minify: true,
    sourcemap: true,
  },
  test: { environment: "happy-dom", alias },
});
