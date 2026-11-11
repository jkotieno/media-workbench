import { useEffect, useState } from "react";
import { Cloud, ImageIcon, Music, Film, RefreshCw } from "lucide-react";
import { buildThumbnailUrl } from "@/features/gallery/utils";
import { isAudioFile, isVideoFile } from "@/lib/media";
import { cn } from "@/lib/utils";
import { storageApi, type StorageAvailability } from "@/shared/api/storage.api";
import { useAgentAccessStore } from "@/lib/stores/agentAccessStore";
import { studioPreviewOriginalStatus } from "./studioPreviewOriginalStatus";

type Props = {
  imageId: number;
  filename: string;
  available?: boolean;
  className?: string;
  detail?: boolean;
};

export function StudioPreview(props: Props) {
  return <PreviewImage key={props.imageId} {...props} />;
}

function PreviewImage({ imageId, filename, available = true, className, detail = false }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => { setAttempt(0); setFailed(false); setReady(false); }, [available]);
  const [original, setOriginal] = useState<StorageAvailability | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const galleryRefreshKey = useAgentAccessStore(state => state.galleryRefreshKey);
  const originalsRefreshKey = useAgentAccessStore(state => state.originalsRefreshKey);
  const mediaMutationKey = useAgentAccessStore(state => state.mediaMutation?.mediaIds.includes(imageId) ? state.mediaMutation.key : 0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await storageApi.availability(imageId, controller.signal);
        if (controller.signal.aborted) return;
        setOriginal(value);
        setStatusFailed(false);
        if (["queued", "running"].includes(value.transfer?.state ?? "")) timer = setTimeout(refresh, 1000);
      } catch {
        // A transient status/auth failure must not discard a known source.
        if (!controller.signal.aborted) { setStatusFailed(true); timer = setTimeout(refresh, 15000); }
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [imageId, galleryRefreshKey, originalsRefreshKey, mediaMutationKey]);
  const originalStatus = studioPreviewOriginalStatus(original, statusFailed);
  const video = isVideoFile(filename, filename);
  const audio = isAudioFile(filename, filename);
  const Icon = video ? Film : audio ? Music : ImageIcon;
  const kind = video ? "Video" : audio ? "Audio" : "Image";
  useEffect(() => {
    if (!failed || attempt >= 8) return;
    const timer = window.setTimeout(() => { setFailed(false); setAttempt(value => value + 1); }, Math.min(8000, 500 * 2 ** attempt));
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);
  const thumbnail = `${buildThumbnailUrl(imageId)}&preview_attempt=${attempt}`;
  const source = audio ? thumbnail.replace('/thumbnail?', '/preview?') : thumbnail;
  return (
    <div className={cn("relative flex h-full min-h-24 w-full items-center justify-center overflow-hidden rounded border border-dashed border-amber-500/50 bg-muted/25", className)}
      title={`${kind} preview. ${originalStatus.label}.`}>
      {available && audio ? <div className="z-10 flex w-full flex-col items-center gap-2 px-3 py-10">
        <Music className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Short audio preview</span>
        <audio src={source} controls preload="metadata" className="h-8 max-w-full"
          aria-label={`Short preview of ${filename}`} onClick={event => event.stopPropagation()}
          onLoadedMetadata={() => { setReady(true); setFailed(false); }} onError={() => { setReady(false); setFailed(true); }} />
      </div> : available ? <img src={source} alt={`Preview of ${filename}`}
        className={cn("max-h-full max-w-full object-contain", !ready && "opacity-0")} loading="lazy" decoding="async"
        onLoad={() => { setReady(true); setFailed(false); }} onError={() => { setReady(false); setFailed(true); }} /> : null}
      {!ready && (!audio || !available || failed) ? <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background/90 p-3 text-center text-xs text-muted-foreground">
        <Icon className="h-7 w-7" aria-hidden="true" />
        <span>{!available ? `${kind} preview unavailable` : attempt >= 8 ? "Preview temporarily unavailable" : "Preview arriving…"}</span>
        {available && attempt >= 8 ? <button type="button" className="inline-flex items-center gap-1 underline" onClick={event => { event.stopPropagation(); setAttempt(0); setFailed(true); }}><RefreshCw className="h-3 w-3" />Retry preview</button> : null}
      </div> : null}
      <span className="pointer-events-none absolute right-1 top-1 z-30 inline-flex items-center gap-1 rounded bg-background/95 px-1.5 py-1 text-[10px] font-medium text-foreground shadow-sm">
        {originalStatus.known ? <Cloud className="h-3 w-3" aria-hidden="true" /> : <Icon className="h-3 w-3" aria-hidden="true" />}{originalStatus.label}
      </span>
      {detail ? <div className="absolute inset-x-0 bottom-0 bg-background/95 px-3 py-2 text-center text-xs text-muted-foreground">{video ? "Video still preview. " : audio ? "Short audio excerpt. " : ""}{originalStatus.label}.</div> : null}
    </div>
  );
}
