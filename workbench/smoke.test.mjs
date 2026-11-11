import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createTransformDocument,
  createTransformImageLayer,
  createTransformImageLayerEntry,
  ensureTransformDocument,
} from "@/features/transform/document";
import {
  getTransformAdjustmentFilter,
  getTransformCanvasGeometry,
} from "@/features/transform/render";
import { readFolderImageStream } from "@/lib/folderImageStream";
import { isAudioFile, isVideoFile, isTransformableImageFile } from "@/lib/media";

const fixtures = new URL("../tests/fixtures/transform/healthcare-demo/", import.meta.url);

test("fixture files match the upstream media checksums", async () => {
  const manifest = JSON.parse(await readFile(new URL("sources.json", fixtures)));
  const files = await readdir(fixtures, { recursive: true, withFileTypes: true });
  assert.equal(manifest.length, 13);
  assert.equal(files.filter(file => file.isFile()).length, manifest.length + 2);
  assert.equal(new Set(manifest.map(entry => entry.file)).size, 13);
  for (const { file, sha256 } of manifest) {
    const bytes = await readFile(new URL(file, fixtures));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, file);
    assert.equal([isAudioFile, isVideoFile, isTransformableImageFile]
      .filter(classify => classify(file)).length, 1, file);
  }
});

test("Studio's Transform document preserves an image layer and adjustments", () => {
  const context = {
    sourceImage: { path: "stills/01-listen-clean.jpg", format: "jpeg", width: 1392, height: 752, hash: null },
    project: { id: null, slug: null, folder: null, available_folders: [] },
    initialMode: "edit",
  };
  const document = createTransformDocument(context);
  const overlay = createTransformImageLayer({
    sourcePath: "overlays/title-01.png",
    intrinsicWidth: 1920, intrinsicHeight: 1080,
    sourceWidth: 1392, sourceHeight: 752,
  });
  const layer = createTransformImageLayerEntry(overlay, 0, "Title");
  layer.opacity = 0.5;
  document.edit.imageLayers.push(overlay);
  document.edit.layers.push(layer);
  document.edit.adjustments.brightness = 1.2;
  const reopened = ensureTransformDocument(JSON.parse(JSON.stringify(document)), context);
  assert.equal(reopened.edit.layers[0].opacity, 0.5);
  assert.equal(reopened.edit.imageLayers[0].sourcePath, overlay.sourcePath);
  assert.match(getTransformAdjustmentFilter(reopened.edit.adjustments), /brightness\(1\.2\)/);
  const { width, height } = getTransformCanvasGeometry(reopened);
  assert.deepEqual([width, height], [1392, 752]);
});

test("the gallery transport publishes partial rows and requires stream completion", async () => {
  const item = { id: 1, path: "clips/01-listen.mp4" };
  const batch = JSON.stringify({ items: [item] }) + "\n";
  const progress = [];
  const result = await readFolderImageStream(new Response(batch + '{"complete":true}\n'), rows => {
    progress.push(rows);
    return true;
  });
  assert.deepEqual(progress, [[item]]);
  assert.deepEqual(result, [item]);
  await assert.rejects(readFolderImageStream(new Response(batch), () => true), /before completion/);
});
