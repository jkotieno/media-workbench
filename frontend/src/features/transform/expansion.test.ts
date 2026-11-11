import { describe, it, expect } from "vitest";
import { createTransformDocument, ensureTransformDocument } from "./document";
import { getTransformCanvasGeometry } from "./render";
import { expansionFrame, normalizeTransformExpansion, expansionCoverage, reprojectCoverageEdits } from "./expansion";

const args = { sourceImage: { path: "/source.png", format: "png" as const, width: 512, height: 512 }, project: {}, initialMode: "edit" as const };
describe("expanded Transform frame", () => {
  it("preserves source coordinates, crop snapshot, rotation, draft geometry and legacy rendering", () => {
    const doc = createTransformDocument(args);
    expect(getTransformCanvasGeometry(doc)).toMatchObject({ width: 512, height: 512, offsetX: -0 });
    doc.edit.expansion = { base: { x: 0, y: 0, width: 512, height: 512 }, left: 256, right: 256, top: 0, bottom: 0, transition: 32 };
    expect(getTransformCanvasGeometry(doc)).toMatchObject({ width: 1024, height: 512, offsetX: 256 });
    doc.edit.crop = { enabled: true, x: 40, y: 60, width: 320, height: 240, aspectRatio: "free" };
    doc.edit.sourceImageTransform.rotationDegrees = 90;
    doc.edit.expansion = { ...doc.edit.expansion, base: { x: 40, y: 60, width: 320, height: 240 }, left: 80, top: 100, right: 20, bottom: 10 };
    const before = getTransformCanvasGeometry(doc);
    expect(before).toMatchObject({ width: 420, height: 350, minX: -40, minY: -40 });
    doc.mask = { ...doc.mask, hasDraft: true, coverageAssetPath: "/coverage.png", baseCoverageAssetPath: "/base.png",
      coverageFrame: { x: -40, y: -40, width: 420, height: 350 } };
    const reopened = ensureTransformDocument(JSON.parse(JSON.stringify(doc)), args);
    expect(getTransformCanvasGeometry(reopened)).toEqual(before);
    expect(reopened.mask).toMatchObject({ coverageFrame: doc.mask.coverageFrame, baseCoverageAssetPath: "/base.png", coverageAssetPath: "/coverage.png" });
    expect(reopened.sourceImage).toEqual(args.sourceImage);
    reopened.edit.expansion = null;
    expect(getTransformCanvasGeometry(reopened)).toMatchObject({ width: 512, height: 512 });
  });
  it("rejects invalid and oversized allocations before rendering", () => {
    const valid = { base: { x: -20, y: -10, width: 512, height: 512 }, left: 0, top: 0, right: 0, bottom: 0, transition: 0 };
    expect(expansionFrame(valid).x).toBe(-20);
    for (const patch of [{ left: -1 }, { top: NaN }, { right: .5 }, { bottom: 16384 }]) {
      expect(() => normalizeTransformExpansion({ ...valid, ...patch })).toThrow();
    }
  });
  it("rebuilds border and seam while reprojecting brush edits without repeated feathering", () => {
    const expansion = { base: { x: 10, y: 20, width: 8, height: 6 }, left: 2, top: 1, right: 0, bottom: 0, transition: 0 };
    const frame = expansionFrame(expansion), base = expansionCoverage(expansion);
    expect(base[0]).toBe(255); expect(base[frame.width + 2]).toBe(0);
    expect(base[frame.width * 6 + 9]).toBe(0); // unexpanded right/bottom edges remain protected
    const edited = base.slice(); edited[3 * frame.width + 5] = 211; edited[frame.width + 1] = 0;
    const next = { ...expansion, left: 4, top: 3, transition: 2 };
    const newFrame = expansionFrame(next), newBase = expansionCoverage(next);
    const projected = reprojectCoverageEdits(newBase, newFrame, edited, frame, base);
    expect(projected[5 * newFrame.width + 7]).toBe(211);
    expect(projected[3 * newFrame.width + 3]).toBe(0);
    expect(projected[0]).toBe(255);
    expect(reprojectCoverageEdits(newBase, newFrame, projected, newFrame, newBase)).toEqual(projected);
    expect(() => reprojectCoverageEdits(newBase, newFrame, edited.slice(1), frame, base)).toThrow();
  });
});
