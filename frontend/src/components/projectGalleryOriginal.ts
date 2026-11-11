import type {FolderImage, GalleryItem} from "@/lib/api";
import {makeMediaOriginalAvailable} from "@/shared/api/mediaOriginal";

/** Acquire verified original bytes for a project-gallery action. */
export async function acquireProjectGalleryOriginal(image: FolderImage, signal?: AbortSignal): Promise<number | undefined> {
 signal?.throwIfAborted();
 if (!image.cloud_reference) return;
 const source = image as FolderImage & {id?: unknown; image_id?: unknown};
 const id = source.image_id ?? source.id;
 if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || !await makeMediaOriginalAvailable(id)) {
  throw Error("The original is unavailable. Reconnect its source and retry.");
 }
 signal?.throwIfAborted();
 return id;
}

/** Preserve catalog identity when preparing original bytes for Pipe input. */
export async function resolveProjectGalleryOriginal(
 image:FolderImage,resolveItem:()=>Promise<GalleryItem|null>,signal?:AbortSignal,
):Promise<GalleryItem|null>{
 const remoteId = await acquireProjectGalleryOriginal(image, signal);
 const item=await resolveItem();
 signal?.throwIfAborted();
 // Even after caching locally, the logical /input/ path belongs to its source
 // machine. Keep the remote flag so shared Prompt transfer copies to the engine.
 return item&&remoteId?{...item,image:{...item.image,id:remoteId,cloud_reference:true}}:item;
}
