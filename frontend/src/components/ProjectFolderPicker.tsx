import {useEffect, useMemo, useRef, useState} from "react";
import {ChevronRight, FolderOpen, ArrowUp, Search} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {useTranslation} from "react-i18next";
import {API_BASE, fetchJson} from "@/shared/api/client";
import {folderChildren} from "@/lib/projectFolderNavigation";

type FolderPage = {items: {id:string;path:string}[]; next_offset:number|null;total:number};
export type ProjectFolderPickerProps = {projectId?:number; allowRoot?:boolean; value: string; folders: string[]; onValueChange: (path: string) => void; className?: string; label?: string; writableOnly?:boolean; manageFolders?:boolean; stableSelection?:boolean; embedded?:boolean; allowSourceSettings?:boolean};
export function LegacyProjectFolderPicker({projectId, allowRoot=false, value, folders, onValueChange, className="", label}: ProjectFolderPickerProps) {
  const {t}=useTranslation("projects");
  const [open,setOpen]=useState(false), [path,setPath]=useState(""), [query,setQuery]=useState(""), [scroll,setScroll]=useState(0);
  const [page,setPage]=useState<FolderPage|null>(null), [loading,setLoading]=useState(false), [error,setError]=useState("");
  const [offset,setOffset]=useState(0);
  useEffect(()=>{
    if(!open||!projectId)return;
    const controller=new AbortController();
    setLoading(true);setError("");
    const timer=setTimeout(()=>{
      const params=new URLSearchParams({parent:path,search:query,offset:String(offset)});
      void fetchJson<FolderPage>(API_BASE+"/projects/"+projectId+"/folder-children?"+params,{signal:controller.signal})
        .then(next=>{if(!controller.signal.aborted)setPage(previous=>offset&&previous?{...next,items:[...previous.items,...next.items]}:next);})
        .catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:t("folderBrowser.failed"));})
        .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    },query?150:0);
    return()=>{clearTimeout(timer);controller.abort();};
  },[open,projectId,path,query,offset,t]);
  const localRows=useMemo(()=>query.trim()?folders.filter(f=>f.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort():folderChildren(folders,path),[folders,path,query]);
  const rows=projectId?(page?.items.map(row=>row.path)??[]):localRows;
  const list=useRef<HTMLDivElement>(null);
  const [focusedIndex,setFocusedIndex]=useState(0);
  const start=Math.max(0,Math.floor(scroll/40)-4), visible=rows.slice(start,start+18);
  const segments=path.split("/").filter(Boolean);
  const go=(next:string)=>{setPath(next);setQuery("");setScroll(0);setOffset(0);setPage(null);setFocusedIndex(0);};
  return <Dialog open={open} onOpenChange={next=>{if(next)go(value);setOpen(next);}}><DialogTrigger asChild>
    <Button type="button" variant="outline" className={"h-8 w-full min-w-0 justify-start gap-2 text-xs "+className} title={value} aria-label={label??t("folderBrowser.choose")}>
      <FolderOpen className="h-3.5 w-3.5 shrink-0"/><span className="truncate">{value||t("folderBrowser.choose")}</span>
    </Button></DialogTrigger>
    <DialogContent className="flex w-[calc(100vw-24px)] max-w-lg max-h-[85dvh] flex-col gap-3 overflow-hidden p-4"><DialogHeader className="shrink-0 pr-6"><DialogTitle>{label??t("folderBrowser.choose")}</DialogTitle></DialogHeader>
      <div className="flex shrink-0 items-center gap-2"><Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={!path&&!query} aria-label={t("folderBrowser.up")} onClick={()=>go(path.split("/").slice(0,-1).join("/"))}><ArrowUp size={15}/></Button>
        <select aria-label={t("folderBrowser.ancestors")} className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-xs" value={path} onChange={e=>go(e.target.value)}><option value="">{t("folderBrowser.root")}</option>{segments.map((_,i)=><option key={i} value={segments.slice(0,i+1).join("/")}>{segments.slice(0,i+1).join(" / ")}</option>)}</select>
      </div>
      <div className="relative shrink-0"><Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground"/><Input value={query} onChange={e=>{setQuery(e.target.value);setScroll(0);setOffset(0);setPage(null);}} className="h-8 pl-8 text-xs" placeholder={t("folderBrowser.search")} aria-label={t("folderBrowser.search")}/></div>
      {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
      {loading&&<p role="status" className="text-xs text-muted-foreground">{t("folderBrowser.loading")}</p>}
      <div ref={list} key={path+"|"+query} className="min-h-0 max-h-72 overflow-y-auto overscroll-contain rounded border" onScroll={e=>setScroll(e.currentTarget.scrollTop)} role="group" aria-label={t("folderBrowser.children")}>
        {!rows.length&&!loading?<p className="p-3 text-xs text-muted-foreground">{t(query?"folderBrowser.noMatches":"folderBrowser.noChildren")}</p>:<div style={{height:rows.length*40,position:"relative"}}>{visible.map((folder,i)=><button type="button" key={folder} data-folder-index={start+i} tabIndex={focusedIndex===start+i?0:-1} onFocus={()=>setFocusedIndex(start+i)} onKeyDown={event=>{const delta=event.key==="ArrowDown"?1:event.key==="ArrowUp"?-1:0;if(!delta)return;event.preventDefault();const index=Math.max(0,Math.min(rows.length-1,start+i+delta));setFocusedIndex(index);if(list.current){const top=index*40;if(top<list.current.scrollTop)list.current.scrollTop=top;else if(top+40>list.current.scrollTop+list.current.clientHeight)list.current.scrollTop=top+40-list.current.clientHeight;}requestAnimationFrame(()=>list.current?.querySelector<HTMLButtonElement>('[data-folder-index="'+index+'"]')?.focus());}} className="absolute left-0 flex h-10 w-full items-center gap-2 px-3 text-left text-xs hover:bg-muted focus-visible:bg-muted" style={{top:(start+i)*40}} title={folder} onClick={()=>go(folder)}><FolderOpen size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{query?folder:folder.split("/").slice(-1)[0]}</span><ChevronRight size={14}/></button>)}</div>}
      </div>
      {page?.next_offset!=null&&<Button type="button" variant="outline" size="sm" disabled={loading} onClick={()=>setOffset(page.next_offset!)}>{t("folderBrowser.more")}</Button>}
      <p className="shrink-0 break-all text-xs text-muted-foreground" title={path}>{path||t("folderBrowser.root")}</p>
      <Button type="button" size="sm" className="shrink-0" disabled={(!path&&!allowRoot)||loading||Boolean(error)} onClick={()=>{onValueChange(path);setOpen(false);}}>{t("folderBrowser.use")}</Button>
    </DialogContent></Dialog>;
}

export {ProjectFolderPicker} from "./ProjectMediaFolderPicker";
