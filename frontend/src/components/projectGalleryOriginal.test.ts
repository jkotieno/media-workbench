import {beforeEach,describe,expect,it,vi} from "vitest";
import type {FolderImage,GalleryItem} from "@/lib/api";
import {resolveProjectGalleryOriginal} from "./projectGalleryOriginal";
import {makeMediaOriginalAvailable} from "@/shared/api/mediaOriginal";
import {buildUseInPipeTransferLoadParams} from "@/features/prompt-studio/promptTransferRequest";
vi.mock("@/shared/api/mediaOriginal",()=>({makeMediaOriginalAvailable:vi.fn()}));
const image={image_id:42,path:"/old/input/original.png",filename:"original.png",mtime:"1",cloud_reference:true} as unknown as FolderImage;
const item={image:{id:-1,path:image.path,filename:image.filename},prompt:"neutral",job_params:{}} as GalleryItem;
beforeEach(()=>vi.resetAllMocks());
describe("project folder original Use in Pipe",()=>{
 it("acquires before metadata and preserves identity/copy intent through shared transfer",async()=>{
  const order:string[]=[];vi.mocked(makeMediaOriginalAvailable).mockImplementation(async id=>{expect(id).toBe(42);order.push("original");return true;});
  const resolved=await resolveProjectGalleryOriginal(image,async()=>{order.push("metadata");return item;});
  expect(order).toEqual(["original","metadata"]);expect(resolved!.image.id).toBe(42);
  expect(buildUseInPipeTransferLoadParams({workflowId:"7",imagePath:image.path,galleryItem:resolved!}).loadParams.__alwaysCopyMedia).toBe(true);
 });
 it.each([false,"failure"])("does not commit metadata/preview on unavailable original %s",async result=>{
  const resolve=vi.fn(async()=>item);if(result===false)vi.mocked(makeMediaOriginalAvailable).mockResolvedValue(false);else vi.mocked(makeMediaOriginalAvailable).mockRejectedValue(Error("offline"));
  await expect(resolveProjectGalleryOriginal(image,resolve)).rejects.toThrow();expect(resolve).not.toHaveBeenCalled();
 });
 it("rejects remote records without a catalog id",async()=>{
  await expect(resolveProjectGalleryOriginal({...image,image_id:undefined} as FolderImage,async()=>item)).rejects.toThrow();expect(makeMediaOriginalAvailable).not.toHaveBeenCalled();
 });
 it("cannot resolve or commit after cancellation while acquiring",async()=>{
  const controller=new AbortController();vi.mocked(makeMediaOriginalAvailable).mockImplementation(async()=>{controller.abort();return true;});const resolve=vi.fn(async()=>item);
  await expect(resolveProjectGalleryOriginal(image,resolve,controller.signal)).rejects.toThrow();expect(resolve).not.toHaveBeenCalled();
 });
 it("retains local/provisional payloads and input reuse",async()=>{
  const resolved=await resolveProjectGalleryOriginal({...image,cloud_reference:false},async()=>item);expect(resolved).toBe(item);expect(makeMediaOriginalAvailable).not.toHaveBeenCalled();
 });
});
