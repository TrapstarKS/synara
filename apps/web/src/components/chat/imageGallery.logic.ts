// FILE: imageGallery.logic.ts
// Purpose: Collect every image shared in a chat into one chronological, deduplicated gallery.
// Layer: Pure chat UI logic

import type { ChatMessage } from "~/types";
import {
  buildLocalImageUrl,
  isLocalImageMarkdownSrc,
  localImageFileName,
} from "~/lib/localImageUrls";

export interface ChatGalleryImage {
  id: string;
  src: string;
  name: string;
  origin: "You" | "Agent";
  createdAt: string;
}

const MARKDOWN_IMAGE_PATTERN =
  /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

function isPreviewableImageSource(src: string): boolean {
  if (/^(?:https?:|blob:|data:image\/|\/api\/)/i.test(src.trim())) return true;
  return isLocalImageMarkdownSrc(src);
}

function nameFromSource(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  return localImageFileName(withoutQuery) || "Image";
}

export function extractMarkdownImages(markdown: string): Array<{ src: string; alt: string }> {
  return [...markdown.matchAll(MARKDOWN_IMAGE_PATTERN)].flatMap((match) => {
    const src = (match[2] ?? match[3] ?? "").trim();
    if (!isPreviewableImageSource(src)) return [];
    return [{ src, alt: (match[1] ?? "").trim() }];
  });
}

export function collectChatGalleryImages(
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "text" | "attachments" | "createdAt">>,
): ChatGalleryImage[] {
  const images: ChatGalleryImage[] = [];
  const seenSources = new Set<string>();
  const add = (image: ChatGalleryImage) => {
    const key = image.src.trim();
    if (!key || seenSources.has(key)) return;
    seenSources.add(key);
    images.push(image);
  };

  for (const message of messages) {
    const origin = message.role === "user" ? "You" : "Agent";
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image" || !attachment.previewUrl) continue;
      add({
        id: `${message.id}:attachment:${attachment.id}`,
        src: attachment.previewUrl,
        name: attachment.name,
        origin,
        createdAt: message.createdAt,
      });
    }
    for (const [index, image] of extractMarkdownImages(message.text).entries()) {
      add({
        id: `${message.id}:markdown:${index}`,
        src: image.src,
        name: image.alt || nameFromSource(image.src),
        origin,
        createdAt: message.createdAt,
      });
    }
  }

  return images;
}

export function resolveChatGalleryPreviewUrl(src: string, cwd: string | null): string {
  return isLocalImageMarkdownSrc(src) ? buildLocalImageUrl({ src, cwd: cwd ?? undefined }) : src;
}
