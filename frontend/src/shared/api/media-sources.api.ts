import type {StorageTransfer} from "./storage.api";
import type {GalleryItem} from "@/lib/api";
import type {FolderImage} from "@/lib/types";
import {API_BASE, fetchJson} from "./client";
export type MediaSource = {id:string; name:string; kind:"filesystem"|"s3"; revision:number; availability:"available"|"needs_directory"|"unavailable"|"credentials_required"|"removed"; directory:string|null; capabilities:{browse:boolean;write:boolean;delete:boolean}};
export type MediaRoot = {directory_label?:string;id:string;source_id:string;label:string;prefix:string;revision:number;legacy:boolean;default:boolean;availability:"available"|"needs_directory"|"unavailable"|"credentials_required"|"removed";writable:boolean};
export type MediaFolderMetadata = {id:string;status:"pending"|"ready"|"unavailable";file_count:number|null;last_modified:string|null};
export type MediaFolder = {id:string;path:string;name:string;parent_id:string|null};
export type FolderMove = StorageTransfer&{attachment_id:string;folder_id:string};
export type MediaFolderPage = {move_operation?:StorageTransfer;attachment_revision:number;items:MediaFolder[];ancestors:MediaFolder[];path:string;folder_id:string|null;next_cursor:string|null;writable:boolean};
export function notifyProjectFoldersChanged(projectId:number){window.dispatchEvent(new CustomEvent("st-project-folders-changed",{detail:{projectId}}));}
function changed<T>(projectId:number,result:T){notifyProjectFoldersChanged(projectId);return result;}
const root = API_BASE + "/projects";
function write<T>(path:string, body:unknown, method="POST") {return fetchJson<T>(root+path,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
export function parseMediaSelection(value:unknown): {attachment_id:string;folder_id:string|null}|null {
  if(typeof value!=="string")return null;
  const match=/^media:([0-9a-f]{8}-[0-9a-f-]{27}):([0-9a-f]{8}-[0-9a-f-]{27}|root)$/i.exec(value);
  return match?{attachment_id:match[1],folder_id:match[2]==="root"?null:match[2]}:null;
}
export const mediaSelection = (attachmentId:string,folderId:string|null) => `media:${attachmentId}:${folderId??"root"}`;
export const mediaSourcesApi = {
  list: (signal?:AbortSignal) => fetchJson<{sources:MediaSource[];default_source_id:string|null}>(root+"/media-sources",{signal,cache:"no-store"}),
  create: (name:string,path:string,allow_writes:boolean) => write<MediaSource>("/media-sources",{name,path,allow_writes}),
  setDefault: (source_id:string|null) => write("/media-sources/default",{source_id},"PUT"),
  bind: (source:MediaSource,path:string) => write<MediaSource>("/media-sources/"+source.id+"/directory",{path,expected_revision:source.revision},"PUT"),
  remove: (source:MediaSource) => fetchJson(root+"/media-sources/"+source.id+"?expected_revision="+source.revision,{method:"DELETE"}),
  roots: (projectId:number,signal?:AbortSignal,selected?:{attachment_id:string;folder_id:string|null}|null) => fetchJson<{roots:MediaRoot[];selected:{label:string;path:string}|null;selection_error?:string|null;ownership_context?:unknown;folder_moves?:FolderMove[]}>(root+"/"+projectId+"/media-roots"+(selected?"?"+new URLSearchParams({attachment_id:selected.attachment_id,...(selected.folder_id?{folder_id:selected.folder_id}:{})}):""),{signal,cache:"no-store"}),
  attach: (projectId:number,body:{source_id:string;label:string;prefix:string;writable:boolean;default:boolean}) => write<MediaRoot>("/"+projectId+"/media-roots",body),
  detach: (projectId:number,source:MediaRoot) => fetchJson(root+"/"+projectId+"/media-roots/"+source.id+"?expected_revision="+source.revision,{method:"DELETE"}),
  folders: (projectId:number,attachmentId:string,params:Record<string,string>,signal?:AbortSignal) => fetchJson<MediaFolderPage>(root+"/"+projectId+"/media-roots/"+attachmentId+"/folders?"+new URLSearchParams(params),{signal,cache:"no-store"}),
  folderMetadata: (projectId:number,attachmentId:string,folder_ids:string[],signal?:AbortSignal) => fetchJson<{items:MediaFolderMetadata[]}>(root+"/"+projectId+"/media-roots/"+attachmentId+"/folder-metadata",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({folder_ids}),signal,cache:"no-store"}),
  moveFolder: (projectId:number,attachmentId:string,folderId:string,body:{name:string;parent_id:string|null;expected_revision:number}) => write<MediaFolderPage>("/"+projectId+"/media-roots/"+attachmentId+"/folders/"+folderId,body,"PATCH").then(result=>changed(projectId,result)),
  deleteFolder: (projectId:number,attachmentId:string,folderId:string,expectedRevision:number) => fetchJson<MediaFolderPage>(root+"/"+projectId+"/media-roots/"+attachmentId+"/folders/"+folderId+"?expected_revision="+expectedRevision,{method:"DELETE"}).then(result=>changed(projectId,result)),
  media: (projectId:number,selection:{attachment_id:string;folder_id:string|null},cursor?:string|null,signal?:AbortSignal) => fetchJson<{items:FolderImage[];next_cursor:string|null;writable:boolean}>(root+"/"+projectId+"/media-roots/"+selection.attachment_id+"/media?"+new URLSearchParams({...selection.folder_id?{folder_id:selection.folder_id}:{},...cursor?{cursor}:{}}),{signal,cache:"no-store"}),
  gallery: (projectId:number,selection:{attachment_id:string;folder_id:string|null},cursor:string|null,limit:number,search:string) => fetchJson<{items:GalleryItem[];next_cursor:string|null}>(root+"/"+projectId+"/media-roots/"+selection.attachment_id+"/gallery?"+new URLSearchParams({...selection.folder_id?{folder_id:selection.folder_id}:{},...cursor?{cursor}:{},limit:String(limit),search}),{cache:"no-store"}),
  createFolder: (projectId:number,attachmentId:string,parent_id:string|null,name:string) => write<MediaFolder>("/"+projectId+"/media-roots/"+attachmentId+"/folders",{parent_id,name}).then(result=>changed(projectId,result)),
};
