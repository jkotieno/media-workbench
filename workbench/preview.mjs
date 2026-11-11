import {
  createTransformDocument,
  createTransformImageLayer,
  createTransformImageLayerEntry,
} from "@/features/transform/document";
import { drawTransformDocument, getTransformCanvasGeometry } from "@/features/transform/render";

const base = "/tests/fixtures/transform/healthcare-demo/";
const fixture = document.getElementById("fixture");
const overlay = document.getElementById("overlay");
const brightness = document.getElementById("brightness");
const tools = document.getElementById("image-tools");
const canvas = document.getElementById("preview");
const video = document.getElementById("video");
const audio = document.getElementById("audio");
const status = document.getElementById("status");
let revision = 0;

async function loadImage(path) {
  const image = new Image();
  image.src = base + path;
  await image.decode();
  return image;
}

function pauseMedia() {
  for (const player of [video, audio]) {
    player.hidden = true;
    if (!player.hasAttribute("src")) continue;
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
}

function addOption(select, path) {
  const option = document.createElement("option");
  option.value = path;
  option.textContent = path;
  select.append(option);
}

async function preview() {
  const current = ++revision;
  const path = fixture.value;
  const layerPath = overlay.value;
  status.textContent = "Loading " + path;
  try {
    if (/\.(mp4|wav)$/.test(path)) {
      pauseMedia();
      canvas.hidden = true;
      tools.hidden = true;
      const player = path.endsWith(".mp4") ? video : audio;
      player.src = base + path;
      player.hidden = false;
      status.textContent = path;
      return;
    }

    pauseMedia();
    const [image, overlayImage] = await Promise.all([
      loadImage(path), layerPath ? loadImage(layerPath) : null,
    ]);
    if (current !== revision) return;

    const { naturalWidth: width, naturalHeight: height } = image;
    const edit = createTransformDocument({
      sourceImage: { path, width, height, format: path.endsWith(".png") ? "png" : "jpeg", hash: null },
      project: { id: null, slug: null, folder: null, available_folders: [] },
      initialMode: "edit",
    });
    edit.edit.adjustments.brightness = Number(brightness.value);
    const imageLayerImages = new Map();
    if (overlayImage) {
      const layer = createTransformImageLayer({
        sourcePath: layerPath, sourceWidth: width, sourceHeight: height,
        intrinsicWidth: overlayImage.naturalWidth, intrinsicHeight: overlayImage.naturalHeight,
      });
      edit.edit.imageLayers.push(layer);
      edit.edit.layers.push(createTransformImageLayerEntry(layer, 0));
      imageLayerImages.set(layer.id, overlayImage);
    }

    const geometry = getTransformCanvasGeometry(edit);
    canvas.width = geometry.width;
    canvas.height = geometry.height;
    drawTransformDocument(canvas.getContext("2d"), image, edit, null, {
      imageLayerImages, renderDecorations: false,
    });
    canvas.hidden = false;
    tools.hidden = false;
    status.textContent = path + " · " + width + " × " + height;
  } catch (error) {
    if (current !== revision) return;
    canvas.hidden = true;
    status.textContent = "Could not load " + path + ". " + error.message;
  }
}

try {
  const response = await fetch(base + "sources.json");
  if (!response.ok) throw new Error("Fixture index is unavailable.");
  for (const { file } of await response.json()) {
    addOption(fixture, file);
    if (file.startsWith("overlays/")) addOption(overlay, file);
  }
  fixture.addEventListener("change", preview);
  overlay.addEventListener("change", preview);
  brightness.addEventListener("input", preview);
  await preview();
} catch (error) {
  status.textContent = error.message;
}
