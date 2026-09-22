// FILE: LocalVideoPreview.tsx
// Purpose: Preview allowlisted local video files without sending binary bytes
//          through the workspace text-file RPC.
// Layer: Web UI primitive
// Exports: LocalVideoPreview

import { useState } from "react";

import { DownloadIcon, Loader2Icon } from "~/lib/icons";
import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";
import { LocalImageErrorCard, useLocalImageDownloadClick } from "./LocalImagePreview";

export function LocalVideoPreview(props: {
  src: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  cacheKey?: string | number | undefined;
  className?: string;
  videoClassName?: string;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: (() => void) | undefined;
}) {
  const { src, cwd, previewGrant } = props;
  const previewUrl = buildLocalImageUrl({
    src,
    cwd: cwd ?? undefined,
    grant: previewGrant,
    cacheKey: props.cacheKey,
  });
  const downloadUrl = buildLocalImageUrl({
    src,
    cwd: cwd ?? undefined,
    grant: previewGrant,
    download: true,
  });
  const fileName = localImageFileName(src);
  const [storedLoad, setStoredLoad] = useState<{
    url: string;
    status: "loading" | "ready" | "error";
  }>(() => ({ url: previewUrl, status: "loading" }));
  const load =
    storedLoad.url === previewUrl ? storedLoad : { url: previewUrl, status: "loading" as const };
  if (load !== storedLoad) {
    setStoredLoad(load);
  }

  const settleLoad = (status: "ready" | "error") => {
    setStoredLoad((current) => (current.url === previewUrl ? { ...current, status } : current));
  };
  const handleReady = () => {
    settleLoad("ready");
    props.onPreviewReady?.();
  };
  const handleError = () => {
    settleLoad("error");
    props.onPreviewError?.();
  };
  const handleDownloadClick = useLocalImageDownloadClick({
    downloadUrl,
    downloadName: fileName,
    errorTitle: "Could not download video",
  });

  if (load.status === "error") {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={fileName}
        title="Couldn’t open this video"
        downloadAriaLabel="Download video"
        onDownloadClick={handleDownloadClick}
        className={props.className}
      />
    );
  }

  return (
    <div className={cn("local-image-preview", props.className)} data-status={load.status}>
      {load.status === "loading" ? (
        <span className="local-image-preview__skeleton" aria-hidden="true">
          <Loader2Icon className="size-4 animate-spin opacity-60" />
        </span>
      ) : null}
      <video
        className={cn(
          "local-video-preview__video max-h-[calc(100vh-13rem)] max-w-full rounded-md shadow-sm",
          props.videoClassName,
        )}
        src={previewUrl}
        controls
        playsInline
        preload="metadata"
        aria-label={fileName || "Local video"}
        onLoadedData={handleReady}
        onError={handleError}
      />
      <a
        href={downloadUrl}
        download={fileName}
        onClick={handleDownloadClick}
        className="local-image-preview__download"
        aria-label="Download video"
        title="Download"
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
