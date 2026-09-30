// Filesystem paths and URL destinations have different escaping rules. Keep this
// conversion shared by Markdown producers and consumers, without depending on the
// host OS: the web client can be displaying files from a remote Windows server.
import { isWindowsAbsolutePath } from "./path";

export function encodeFilePathForUrl(filePath: string): string {
  // A backslash is a valid filename character on macOS/POSIX.
  const normalized = isWindowsAbsolutePath(filePath) ? filePath.replaceAll("\\", "/") : filePath;
  return normalized
    .split("/")
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment).replace(
            /[!'()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
    )
    .join("/");
}

export function markdownFilePathHref(filePath: string): string {
  const encoded = encodeFilePathForUrl(filePath);
  return encoded.startsWith("//")
    ? `file:${encoded}`
    : `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

export function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;
    // Dropping the hostname turns a Windows share into an unrelated local path.
    const rawPath = parsed.hostname ? `//${parsed.hostname}${parsed.pathname}` : parsed.pathname;
    if (rawPath.length === 0) return null;
    const normalizedPath = /^\/[A-Za-z]:[\\/]/.test(rawPath) ? rawPath.slice(1) : rawPath;
    let path = normalizedPath;
    if (options?.decodePath !== false) {
      try {
        path = decodeURIComponent(path);
      } catch {
        // Preserve malformed percent sequences, just as raw Markdown paths do.
      }
    }
    return { path, hash: parsed.hash };
  } catch {
    return null;
  }
}
