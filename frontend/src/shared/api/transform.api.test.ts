import {afterEach,describe,expect,it,vi} from "vitest";
import {transformApi} from "./transform.api";
import {createTransformDocument} from "@/features/transform/document";

const documentFor=(path:string,brightness:number)=> {
  const document=createTransformDocument({
    sourceImage:{path,format:"png",width:16,height:16,hash:null},
    project:{id:null,slug:null,folder:null,available_folders:[]},initialMode:"edit",
  });
  document.edit.adjustments.brightness=brightness;
  return document;
};
afterEach(()=>vi.unstubAllGlobals());
describe("Transform document write ordering",()=>{
  it("a slow earlier save cannot replace a newer save, without blocking another image",async()=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const committed:string[]=[];
    const fetcher=vi.fn(async(_url:string,init:RequestInit)=>{
      const doc=JSON.parse(init.body as string).document;
      if(doc.sourceImage.path==="/A.png"&&doc.edit.adjustments.brightness===1) await gate;
      committed.push(doc.sourceImage.path+":"+doc.edit.adjustments.brightness);
      return Response.json({document:doc});
    });
    vi.stubGlobal("fetch",fetcher);
    const first=transformApi.saveTransformDocument(documentFor("/A.png",1));
    const second=transformApi.saveTransformDocument(documentFor("/A.png",2));
    await transformApi.saveTransformDocument(documentFor("/B.png",3));
    expect(committed).toEqual(["/B.png:3"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first,second]);
    expect(committed).toEqual(["/B.png:3","/A.png:1","/A.png:2"]);
  });
  it("a failed earlier request does not strand the latest save or future retries",async()=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let calls=0;
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{
      if(++calls===1){await gate;return Response.json({detail:"disk busy"},{status:503});}
      return Response.json({document:JSON.parse(init.body as string).document});
    }));
    const failed=transformApi.saveTransformDocument(documentFor("/retry.png",1)).catch(e=>e.message);
    const latest=transformApi.saveTransformDocument(documentFor("/retry.png",2));
    release();
    expect(await failed).toBe("disk busy");
    expect((await latest).document.edit.adjustments.brightness).toBe(2);
    expect((await transformApi.saveTransformDocument(documentFor("/retry.png",3))).document.edit.adjustments.brightness).toBe(3);
  });
});


it("retains the acknowledged revision while newer typing keeps an older document snapshot", async () => {
  let revision = 0;
  const observed: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const expected = Number(new Headers(init.headers).get("X-Studio-Recipe-Revision"));
    observed.push(expected);
    if (expected !== revision) return Response.json({detail: {message: "Another window changed this edit."}}, {status: 409});
    const document = JSON.parse(init.body as string).document;
    return Response.json({document: {...document, recipeRevision: ++revision}});
  }));
  const original = documentFor("/typing-revisions.png", 1);
  const newerTyping = structuredClone(original);
  newerTyping.edit.adjustments.brightness = 2;
  await transformApi.saveTransformDocument(original);
  // The UI intentionally ignored the first response because the user kept typing.
  await transformApi.saveTransformDocument(newerTyping);
  expect(observed).toEqual([0, 1]);
  revision = 3; // A different browser has committed another edit.
  await expect(transformApi.saveTransformDocument(newerTyping)).rejects.toThrow("Another window changed this edit.");
  expect(observed).toEqual([0, 1, 2]);
});
