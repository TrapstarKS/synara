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

it("opens unsupported files in the file manager and still offers a download", async () => {
  const workspaceRoot = "/Users/tester/My Project";
  const filePath = "Artifacts/agent output.zip";
  const readFile = vi.fn().mockRejectedValue(new Error("File appears to be binary."));
  const resolveOutOfRootFileReference = vi.fn().mockResolvedValue({ fullPath: null });
  const openInEditor = vi.fn().mockResolvedValue(undefined);
  const restoreNativeApi = installNativeApi({
    projects: { readFile, resolveOutOfRootFileReference },
    shell: { openInEditor },
    server: {
      getConfig: vi
        .fn()
        .mockResolvedValue({ availableEditors: ["vscode", "file-manager"], keybindings: [] }),
    },
  } as unknown as NativeApi);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  try {
    const screen = await render(
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
    expect(openInEditor).not.toHaveBeenCalled();
    await screen
      .getByRole("group", { name: "Open in file manager", exact: true })
      .getByRole("button", { name: "Open", exact: true })
      .click();
    await vi.waitFor(() =>
      expect(openInEditor).toHaveBeenCalledWith(`${workspaceRoot}/${filePath}`, "file-manager"),
    );
  } finally {
    restoreNativeApi();
  }
});
