import { describe, expect, it } from "vitest";

import {
  buildTransformExportedFolderImage,
  mergeTransformExportedFolderImage,
} from "./transformExportGallery";

const normalizePath = (pathStr?: string | null) =>
  (pathStr || "").replace(/\\/g, "/").toLowerCase();

describe("transform export gallery merge", () => {
  it("derives the displayed filename from the exported path instead of a stale response filename", () => {
    const exported = buildTransformExportedFolderImage({
      path: "C:\\tmp\\image_transform_0002.png",
      filename: "image_transform_0001.png",
      saved_at: "2026-05-05T00:00:00Z",
    });

    expect(exported.filename).toBe("image_transform_0002.png");
  });

  it("keeps an overwritten image in its current position and uses the file mtime", () => {
    const merged = mergeTransformExportedFolderImage(
      [
        {
          path: "C:\\tmp\\older.png",
          filename: "older.png",
          mtime: "2026-05-04T00:00:00Z",
        },
        {
          path: "C:\\tmp\\image_transform_0002.png",
          filename: "image_transform_0001.png",
          mtime: "2026-05-04T00:00:01Z",
          width: 512,
          height: 512,
        },
      ],
      {
        path: "C:\\tmp\\image_transform_0002.png",
        filename: "image_transform_0001.png",
        saved_at: "2026-05-05T00:00:00Z",
        mtime: "2026-05-05T00:00:05Z",
        save_mode: "overwrite_current",
      },
      normalizePath,
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]?.filename).toBe("older.png");
    expect(merged[1]).toMatchObject({
      path: "C:\\tmp\\image_transform_0002.png",
      filename: "image_transform_0002.png",
      mtime: "2026-05-05T00:00:05Z",
      width: 512,
      height: 512,
    });
  });

  it("moves a same-path new-copy export to the front", () => {
    const merged = mergeTransformExportedFolderImage(
      [
        {
          path: "C:\\tmp\\older.png",
          filename: "older.png",
          mtime: "2026-05-04T00:00:00Z",
        },
        {
          path: "C:\\tmp\\image_transform_0002.png",
          filename: "image_transform_0001.png",
          mtime: "2026-05-04T00:00:01Z",
          width: 512,
          height: 512,
        },
      ],
      {
        path: "C:\\tmp\\image_transform_0002.png",
        filename: "image_transform_0001.png",
        saved_at: "2026-05-05T00:00:00Z",
        save_mode: "new_copy",
      },
      normalizePath,
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      path: "C:\\tmp\\image_transform_0002.png",
      filename: "image_transform_0002.png",
      mtime: "2026-05-05T00:00:00Z",
      width: 512,
      height: 512,
    });
    expect(merged[1]?.filename).toBe("older.png");
  });
});
