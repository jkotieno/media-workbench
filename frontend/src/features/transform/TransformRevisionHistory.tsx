import {useEffect, useState} from "react";
import {History} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover";
import {transformApi} from "@/shared/api/transform.api";

export function TransformRevisionHistory({sourcePath, onRestore}: {
 sourcePath: string; onRestore: (id: string) => Promise<void>;
}) {
 const [open,setOpen]=useState(false);
 const [items,setItems]=useState<{id: string; conflict: boolean; saved_at: string}[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 useEffect(()=>{
  if(!open)return;
  const controller=new AbortController();setError("");
  void transformApi.transformRevisions(sourcePath,controller.signal).then(value=>{
   if(!controller.signal.aborted)setItems(value.items);
  }).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"Revisions could not be loaded.");});
  return ()=>controller.abort();
 },[open,sourcePath]);
 return <Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="Edit revisions" title="Edit revisions"><History className="h-4 w-4"/></Button></PopoverTrigger>
  <PopoverContent className="z-[350] w-80 max-w-[90vw] space-y-3">
   <p className="text-sm font-medium">Edit revisions</p>
   <p className="text-xs text-muted-foreground">Your current edit is saved before opening a previous version. Preserved drafts are included.</p>
   <div className="max-h-64 space-y-1 overflow-auto">
    {items.length===0 && <p className="text-xs text-muted-foreground">No saved revisions yet.</p>}
    {items.map(item=><Button key={item.id} variant="ghost" size="sm" className="w-full justify-start text-xs" disabled={busy}
     onClick={async()=>{
      setBusy(true);setError("");
      try {await onRestore(item.id);setOpen(false);}
      catch(cause){setError(cause instanceof Error?cause.message:"This revision could not be opened.");}
      finally {setBusy(false);}
     }}>{item.conflict?"Preserved draft":"Revision "+item.id.split("-")[0]} · {new Date(item.saved_at).toLocaleString()}</Button>)}
   </div>
   {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </PopoverContent>
 </Popover>;
}
