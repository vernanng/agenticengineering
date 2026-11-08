import { fileURLToPath } from "node:url";
import path from "node:path";
import lwc from "@lwc/rollup-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

// Rolldown treats bare `.html` imports as static assets and drops plugin
// transforms, so tag LWC templates with a query to keep them as JS modules.
function lwcScopeFix(): Plugin {
  return {
    name: "lwc-scope-fix",
    enforce: "pre",
    resolveId(source, importer) {
      const base = importer?.split("?")[0] ?? "";
      if (base.includes("/src/modules/") && source.endsWith(".html") && source.startsWith(".")) {
        return path.resolve(path.dirname(base), source) + "?lwc";
      }
    },
    configResolved(config) {
      // LWC compiles its own CSS; keep vite:css off src/modules so styles aren't processed twice.
      for (const p of config.plugins) {
        if (p.name !== "vite:css" && p.name !== "vite:css-post") continue;
        const t = p.transform;
        const wrap = (fn: Function) =>
          async function (this: unknown, code: string, id: string, ...rest: unknown[]) {
            if (id.split("?")[0].includes("/src/modules/")) return undefined;
            return fn.call(this, code, id, ...rest);
          };
        if (typeof t === "function") p.transform = wrap(t);
        else if (t && typeof t === "object" && typeof (t as { handler?: unknown }).handler === "function") {
          (t as { handler: Function }).handler = wrap((t as { handler: Function }).handler);
        }
      }
    },
  };
}

// https://vite.dev/config/
const rootDir = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  // rootDir is explicit: the plugin can't infer it in dev, where there is no build input.
  plugins: [lwcScopeFix(), lwc({ include: "**/src/modules/**/*", modules: [{ dir: "src/modules" }], rootDir }), svelte()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/events": "http://localhost:3000",
    },
  },
});
