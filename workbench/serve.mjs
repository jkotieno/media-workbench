import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";

const fixtureRoot = "/tests/fixtures/transform/healthcare-demo/";
const sourceRoot = "/frontend/src/features/transform/";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL(fixtureRoot.slice(1) + "sources.json", root)));
const files = new Set([
  "/workbench/index.html", "/workbench/preview.mjs",
  ...manifest.map(({ file }) => fixtureRoot + file),
  fixtureRoot + "sources.json",
]);
const sourceModules = new Set(["document", "render", "expansion"].map(name => sourceRoot + name));
const types = {
  html: "text/html; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", jpg: "image/jpeg", png: "image/png",
  mp4: "video/mp4", wav: "audio/wav",
};

async function serve(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") pathname = "/workbench/index.html";
  const sourcePath = pathname.replace(/\.ts$/, "");
  if (sourceModules.has(sourcePath)) {
    const code = await readFile(new URL(sourcePath.slice(1) + ".ts", root), "utf8");
    response.writeHead(200, { "Content-Type": types.mjs });
    response.end(request.method === "HEAD" ? undefined : stripTypeScriptTypes(code));
    return;
  }
  if (!files.has(pathname)) {
    response.writeHead(404).end();
    return;
  }

  const file = new URL(pathname.slice(1), root);
  const { size } = await stat(file);
  const headers = {
    "Content-Type": types[pathname.split(".").at(-1)],
    "Accept-Ranges": "bytes",
  };
  let start = 0;
  let end = size - 1;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, { ...headers, "Content-Range": "bytes */" + size }).end();
      return;
    }
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else {
      start = Math.max(0, size - Number(match[2]));
    }
    if (start > end) {
      response.writeHead(416, { ...headers, "Content-Range": "bytes */" + size }).end();
      return;
    }
    headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
  }

  headers["Content-Length"] = end - start + 1;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  response.on("close", () => stream.destroy());
  stream.on("error", error => response.destroy(error));
  stream.pipe(response);
}

const port = Number(process.env.PORT ?? 4173);
const server = createServer((request, response) => {
  serve(request, response).catch(error => {
    console.error(error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log("Media Workbench at http://127.0.0.1:" + server.address().port);
});
