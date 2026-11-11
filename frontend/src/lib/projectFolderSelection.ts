import {parseMediaSelection} from "@/shared/api/media-sources.api";
export type ProjectFolder = {id: string; parent_id: string | null; name: string; path: string};
export type FolderSelection = {projectId: string; path: string; id: string | null};
export function resolveFolderSelection(projectId: string, path: string, folders: string[], tree: ProjectFolder[], previous: FolderSelection | null): FolderSelection {
  const media = parseMediaSelection(path);
  if(media)return {projectId,path,id:media.folder_id};
  const sameSelection = previous?.projectId === projectId && previous.path === path;
  const identified = sameSelection && previous.id ? tree.find(row => row.id === previous.id) : undefined;
  const selected = identified ?? tree.find(row => row.path === path);
  const resolvedPath = selected?.path ?? (path || folders[0] || "");
  return {projectId, path: resolvedPath, id: selected?.id ?? tree.find(row => row.path === resolvedPath)?.id ?? null};
}
