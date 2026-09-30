// FILE: LocalAudioPreview.tsx
// Purpose: Preview allowlisted local audio through the authenticated local-file route.
// Layer: Web UI primitive
// Exports: LocalAudioPreview

import { useState } from "react";

import { DownloadIcon, Loader2Icon } from "~/lib/icons";
import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { LocalImageErrorCard, useLocalImageDownloadClick } from "./LocalImagePreview";

export function LocalAudioPreview(props: {
  src: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  cacheKey?: string | number | undefined;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: (() => void) | undefined;
}) {
  const previewUrl = buildLocalImageUrl({
    src: props.src,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    cacheKey: props.cacheKey,
  });
  const downloadUrl = buildLocalImageUrl({
    src: props.src,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    download: true,
  });
  const fileName = localImageFileName(props.src);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const handleDownloadClick = useLocalImageDownloadClick({
    downloadUrl,
    downloadName: fileName,
    errorTitle: "Could not download audio",
  });

  if (failedUrl === previewUrl) {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={fileName}
        title="Couldn’t open this audio"
        downloadAriaLabel="Download audio"
        onDownloadClick={handleDownloadClick}
        className="min-h-full"
      />
    );
  }

  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="relative flex w-full max-w-xl flex-col items-center gap-3 rounded-lg border border-border/70 bg-muted/15 p-5">
        <p className="max-w-full truncate text-ui-sm font-medium text-foreground">{fileName}</p>
        {readyUrl !== previewUrl ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : null}
        <audio
          className="w-full"
          src={previewUrl}
          controls
          preload="metadata"
          aria-label={fileName || "Local audio"}
          onLoadedMetadata={() => {
            setReadyUrl(previewUrl);
            props.onPreviewReady?.();
          }}
          onError={() => {
            setFailedUrl(previewUrl);
            props.onPreviewError?.();
          }}
        />
        <a
          href={downloadUrl}
          download={fileName}
          onClick={handleDownloadClick}
          className="inline-flex items-center gap-1.5 text-ui-sm text-muted-foreground hover:text-foreground"
        >
          <DownloadIcon className="size-3.5" aria-hidden="true" />
          Download
        </a>
      </div>
    </div>
  );
}
