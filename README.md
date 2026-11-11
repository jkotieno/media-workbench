# Media Workbench

A focused source snapshot of the media editing and delivery paths from Sweet Tea Studio. The browser workbench uses Studio's existing Transform document and canvas renderer and loads the bundled fixtures directly from disk via a local server.

## Run locally

Use Node.js 22.18 or newer. There is nothing to install.

```sh
npm test
npm start
```

Open http://127.0.0.1:4173. Select a still to render it, change its brightness, or add one of the transparent title images. Select a clip, the voiceover, or the finished reference to open it in the browser's native media player. A browser with H.264 support is needed for MP4 playback.

## Source map

| Path | Code |
| --- | --- |
| `frontend/src/features/transform/` | Image Transform workspace, document, layers, canvas and raster tools, launch, autosave, history, and export |
| `frontend/src/components/ProjectGallery*.tsx` and `frontend/src/lib/folderImageStream.ts` | Media browsing, progressive selection, original retrieval, and Transform launch |
| `frontend/src/shared/api/transform.api.ts` and nearby media API modules | Transform and media transport contracts |
| `frontend/src/features/ancestry/SavedConfigurator.tsx` and `savedConfigurator.ts` | Saved controls and associated media from prior executions |
| `backend/app/api/endpoints/transform*.py` and selected services | Studio API handlers, revision history, media operations, and source resolution |
| `tests/fixtures/transform/healthcare-demo/` | Fictional healthcare demo stills, raw clips, alpha overlays, voiceover, and a finished reference |
| `workbench/` | Local fixture browser, Node loader, and smoke tests |

The extracted frontend and backend integration files retain their original paths and imports. Some imports point into the larger Studio app. The root commands run the standalone workbench and smoke tests. The original colocated tests are included as source context and use Studio's Vitest or pytest setup.
