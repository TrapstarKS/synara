// FILE: WorkspaceFilePreview.binary.browser.tsx
// Purpose: Browser regressions for useful fallback rendering of non-text workspace files.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: api,
  });
  return () => {
    if (previousDescriptor) Object.defineProperty(window, "nativeApi", previousDescriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("offers a download instead of decoding a ZIP as text", async () => {
  const workspaceRoot = "/Users/tester/My Project";
  const filePath = "Artifacts/agent output.zip";
  const readFile = vi.fn().mockRejectedValue(new Error("File appears to be binary."));
  const resolveOutOfRootFileReference = vi.fn().mockResolvedValue({ fullPath: null });
  const restoreNativeApi = installNativeApi({
    projects: { readFile, resolveOutOfRootFileReference },
  } as unknown as NativeApi);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={workspaceRoot} filePath={filePath} />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("ZIP file");
      const download = document.querySelector<HTMLAnchorElement>('a[download="agent output.zip"]');
      expect(download?.href).toContain("/api/local-image?");
      expect(download?.href).toContain("path=Artifacts%2Fagent+output.zip");
      expect(download?.href).toContain("download=1");
    });
  } finally {
    restoreNativeApi();
  }
});
