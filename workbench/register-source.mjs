import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const source = new URL("../frontend/src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let url;
    if (specifier.startsWith("@/")) {
      url = new URL(specifier.slice(2), source);
    } else if (context.parentURL?.startsWith(source.href) && specifier.startsWith(".")) {
      url = new URL(specifier, context.parentURL);
    }
    if (url?.href.startsWith(source.href)) {
      const typescript = new URL(url.href + ".ts");
      if (existsSync(fileURLToPath(typescript))) url = typescript;
      return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});
