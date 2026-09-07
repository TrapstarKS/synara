// FILE: ImagesPanel.tsx
// Purpose: Responsive chat image gallery used by the desktop right dock and its mobile sheet.
// Layer: Chat right-dock UI

import type { ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import type { ChatMessage } from "~/types";
import { ImageIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createThreadSelector } from "~/storeSelectors";
import { ExpandedImageOverlay } from "./ExpandedImageOverlay";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  collectChatGalleryImages,
  resolveChatGalleryPreviewUrl,
  type ChatGalleryImage,
} from "./imageGallery.logic";

function GalleryThumbnail(props: {
  image: ChatGalleryImage;
  previewUrl: string;
  onOpen: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === props.previewUrl;

  return (
    <button
      type="button"
      className="group min-w-0 overflow-hidden rounded-xl border border-border/70 bg-muted/20 text-left outline-hidden transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60"
      aria-label={`Open ${props.image.name}`}
      onClick={props.onOpen}
      disabled={failed}
    >
      <span className="flex aspect-square items-center justify-center overflow-hidden bg-muted/40">
        {failed ? (
          <ImageIcon className="size-6 text-muted-foreground/55" aria-hidden />
        ) : (
          <img
            src={props.previewUrl}
            alt={props.image.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            onError={() => setFailedUrl(props.previewUrl)}
          />
        )}
      </span>
      <span className="block min-w-0 px-2.5 py-2">
        <span className="block truncate text-xs font-medium text-foreground">
          {props.image.name}
        </span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">{props.image.origin}</span>
      </span>
    </button>
  );
}

export function ImagesPanel(props: {
  messages: ReadonlyArray<ChatMessage>;
  cwd: string | null;
  className?: string;
}) {
  const images = useMemo(() => collectChatGalleryImages(props.messages), [props.messages]);
  const previewImages = useMemo(
    () =>
      images.map((image) => ({
        src: resolveChatGalleryPreviewUrl(image.src, props.cwd),
        name: image.name,
      })),
    [images, props.cwd],
  );
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  useEffect(() => {
    if (!expandedImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpandedImage(null);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setExpandedImage((current) => {
          if (!current || current.images.length <= 1) return current;
          const direction = event.key === "ArrowLeft" ? -1 : 1;
          return {
            ...current,
            index: (current.index + direction + current.images.length) % current.images.length,
          };
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedImage]);

  return (
    <div className={cn("h-full overflow-y-auto px-3 py-5", props.className)}>
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-xs font-normal text-muted-foreground">Images</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{images.length}</span>
      </div>
      {images.length === 0 ? (
        <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
            <ImageIcon className="size-5" aria-hidden />
          </span>
          <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">
            Images shared or generated in this chat will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {images.map((image, index) => (
            <GalleryThumbnail
              key={image.id}
              image={image}
              previewUrl={previewImages[index]?.src ?? image.src}
              onOpen={() => setExpandedImage({ images: previewImages, index })}
            />
          ))}
        </div>
      )}
      <ExpandedImageOverlay
        expandedImage={expandedImage}
        onClose={() => setExpandedImage(null)}
        onNavigate={(direction) =>
          setExpandedImage((current) => {
            if (!current || current.images.length <= 1) return current;
            return {
              ...current,
              index: (current.index + direction + current.images.length) % current.images.length,
            };
          })
        }
      />
    </div>
  );
}

const EMPTY_MESSAGES: readonly ChatMessage[] = [];

/** Keeps live transcript subscriptions inside the mounted pane, so a closed
 * gallery cannot make the whole chat shell rerender during streaming. */
export function ThreadImagesPanel(props: { threadId: ThreadId; cwd: string | null }) {
  const thread = useStore(useMemo(() => createThreadSelector(props.threadId), [props.threadId]));
  return <ImagesPanel messages={thread?.messages ?? EMPTY_MESSAGES} cwd={props.cwd} />;
}
