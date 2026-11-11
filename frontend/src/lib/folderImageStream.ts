import type {FolderImage} from "@/lib/api";

/** Partial rows are display-only. Only a complete, current read may replace a view/cache. */
export async function readFolderImageStream(
  response: Response,
  onPartial: (images: FolderImage[]) => boolean,
): Promise<FolderImage[] | null> {
  if (!response.body) throw new Error("Folder stream is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const images: FolderImage[] = [];
  let pending = "", complete = false;
  const line = (text: string) => {
    if (!text.trim()) return true;
    if (complete) throw new Error("Unexpected data after folder completion");
    const message = JSON.parse(text);
    if (message.complete === true) { complete = true; return true; }
    if (!Array.isArray(message.items)) throw new Error("Invalid folder batch");
    images.push(...message.items);
    return onPartial([...images]);
  };
  try {
    for (;;) {
      const {value, done} = await reader.read();
      pending += decoder.decode(value, {stream: !done});
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const text = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line(text)) return null;
      }
      if (done) break;
    }
    if (pending.trim() && !line(pending)) return null;
    if (!complete) throw new Error("Folder read ended before completion");
    return images;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
