import "../../index.css";
import { ThreadId, type FilesystemStatResult, type NativeApi } from "@synara/contracts";
import { markdownFilePathHref } from "@synara/shared/fileUrls";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import ChatMarkdown from "../ChatMarkdown";
import { DockExplorerPane } from "./DockExplorerPane";
import {
  requestExplorerReveal,
  useExplorerRevealRequestStore,
} from "../../explorerRevealRequestStore";
import {
  prefetchWorkspaceFile,
  resolveWorkspaceFileOpenTarget,
  useWorkspacePathOpener,
  WorkspaceFileOpenerContext,
} from "../../lib/workspaceFileOpener";
import { toastManager } from "../ui/toast";

const threadId = ThreadId.makeUnsafe("path-links");
const stat = vi.fn<NativeApi["filesystem"]["stat"]>();
const openFile = vi.fn(() => true);
const openInEditor = vi.fn().mockResolvedValue(undefined);
const readFile = vi.fn();
const listDirectories = vi.fn<NativeApi["projects"]["listDirectories"]>();
let restoreApi: () => void;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  stat.mockReset();
  openFile.mockReturnValue(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      filesystem: { stat },
      projects: {
        listDirectories,
        readFile,
        searchEntries: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
      },
      shell: { openInEditor },
      server: {
        getConfig: vi.fn().mockResolvedValue({ availableEditors: ["vscode"], keybindings: [] }),
      },
    },
  });
  restoreApi = () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };
});

afterEach(() => {
  client.clear();
  restoreApi();
  useExplorerRevealRequestStore.setState({ requestsByThreadId: {} });
  vi.restoreAllMocks();
});

function Harness(props: {
  markdown: string;
  cwd: string | null;
  scopeKey?: string;
  editor?: boolean;
}) {
  const [explorerOpen, setExplorerOpen] = useState(false);
  const queryClient = useQueryClient();
  const opener = useWorkspacePathOpener({
    scopeKey: props.scopeKey ?? "test",
    workspaceRoot: props.cwd,
    enabled: true,
    openFile,
    ...(!props.editor
      ? {
          openDirectory: (path: string) => {
            setExplorerOpen(true);
            requestExplorerReveal(threadId, path);
          },
        }
      : {}),
    prefetchFile: (path) => {
      const relativePath = resolveWorkspaceFileOpenTarget(path, props.cwd);
      if (props.cwd && relativePath) prefetchWorkspaceFile(queryClient, props.cwd, relativePath);
    },
  });
  return (
    <WorkspaceFileOpenerContext.Provider value={opener}>
      <ChatMarkdown text={props.markdown} cwd={props.cwd ?? undefined} />
      {explorerOpen && <DockExplorerPane threadId={threadId} workspaceRoot={props.cwd} isVisible />}
    </WorkspaceFileOpenerContext.Provider>
  );
}

function view(props: Parameters<typeof Harness>[0]) {
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <Harness {...props} />
      </QueryClientProvider>
    </StrictMode>
  );
}

it.each([
  { cwd: "/repo", href: "docs", path: "/repo/docs", relative: "docs" },
  { cwd: "/repo", href: "backup.zip", path: "/repo/backup.zip", relative: "backup.zip" },
  { cwd: "/repo", href: ".synara", path: "/repo/.synara", relative: ".synara" },
  {
    cwd: "/repo",
    href: markdownFilePathHref("/repo/space (100%) #1"),
    path: "/repo/space (100%) #1",
    relative: "space (100%) #1",
  },
  { cwd: "C:/Repo", href: String.raw`C:\Repo\.codex`, path: "C:/Repo/.codex", relative: ".codex" },
  { cwd: "C:/Repo", href: "C:/Repo/docs", path: "C:/Repo/docs", relative: "docs" },
  { cwd: "C:/Repo", href: String.raw`C:/Repo/a\(b\)`, path: "C:/Repo/a(b)", relative: "a(b)" },
  {
    cwd: String.raw`\\server\share\repo`,
    href: "file://server/share/repo/docs",
    path: "//server/share/repo/docs",
    relative: "docs",
  },
])(
  "opens folder $href in the explorer instead of the file reader",
  async ({ cwd, href, path, relative }) => {
    stat.mockResolvedValue({ path, kind: "directory", workspaceRelativePath: relative });
    listDirectories.mockImplementation(async ({ relativePath }) => ({
      entries: relativePath
        ? [{ path: `${relative}/child.txt`, name: "child.txt", kind: "file" }]
        : [{ path: relative, name: relative, kind: "directory", hasChildren: true }],
    }));
    await render(view({ cwd, markdown: `[location](${href})` }));
    await page.getByRole("link", { name: "location", exact: true }).click();
    await expect.element(page.getByTitle(`${relative}/child.txt`, { exact: true })).toBeVisible();
    expect(stat).toHaveBeenCalledWith({ path, cwd });
    expect(openFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(openInEditor).not.toHaveBeenCalled();
  },
);

it.each([
  { path: "/Users/tester/outside", kind: "directory" as const, relative: null },
  { path: "/", kind: "directory" as const, relative: null },
  { path: "/Volumes", kind: "directory" as const, relative: null },
  { path: "//server/share/folder", kind: "directory" as const, relative: null },
  { path: "/repo/.git", kind: "directory" as const, relative: ".git" },
  { path: "/repo/ipc.sock", kind: "other" as const, relative: null },
])(
  "opens $kind $path with the file manager on the active host",
  async ({ path, kind, relative }) => {
    stat.mockResolvedValue({ path, kind, workspaceRelativePath: relative });
    await render(view({ cwd: "/repo", markdown: `[location](${markdownFilePathHref(path)})` }));
    await page.getByRole("link", { name: "location", exact: true }).click();
    await vi.waitFor(() => expect(openInEditor).toHaveBeenCalledWith(path, "file-manager"));
    expect(openFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  },
);

it("opens editor-view folder links without selecting a file or discarding the edit buffer", async () => {
  stat.mockResolvedValue({ path: "/repo/docs", kind: "directory", workspaceRelativePath: "docs" });
  await render(view({ cwd: "/repo", markdown: "[location](docs)", editor: true }));
  await page.getByRole("link", { name: "location", exact: true }).click();
  await vi.waitFor(() => expect(openInEditor).toHaveBeenCalledWith("/repo/docs", "file-manager"));
  expect(openFile).not.toHaveBeenCalled();
});

it("keeps extensionless files and line positions in the file opener", async () => {
  stat.mockResolvedValue({ path: "/repo/LICENSE", kind: "file", workspaceRelativePath: null });
  await render(view({ cwd: "/repo", markdown: "[license](LICENSE#L4)" }));
  await page.getByRole("link", { name: "license", exact: true }).click();
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith("/repo/LICENSE:4"));
  expect(openInEditor).not.toHaveBeenCalled();
});

it("preserves basename relocation for a file absent at the linked path", async () => {
  stat.mockResolvedValue({
    path: "/repo/example.ts",
    kind: "missing",
    workspaceRelativePath: null,
  });
  await render(view({ cwd: "/repo", markdown: "[file](example.ts)" }));
  await page.getByRole("link", { name: "file", exact: true }).click();
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith("/repo/example.ts"));
});

it("keeps modified folder clicks out of the code editor", async () => {
  stat.mockResolvedValue({ path: "/repo/docs", kind: "directory", workspaceRelativePath: "docs" });
  await render(view({ cwd: "/repo", markdown: "[folder](docs)" }));
  page
    .getByRole("link", { name: "folder", exact: true })
    .element()
    .dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );
  await vi.waitFor(() => expect(openInEditor).toHaveBeenCalledWith("/repo/docs", "file-manager"));
  expect(openFile).not.toHaveBeenCalled();
});

it("ignores a late folder result after a newer click", async () => {
  let resolveFolder!: (result: FilesystemStatResult) => void;
  stat.mockImplementation(async ({ path }) =>
    path.endsWith("/docs")
      ? new Promise<FilesystemStatResult>((resolve) => {
          resolveFolder = resolve;
        })
      : { path, kind: "file", workspaceRelativePath: null },
  );
  await render(view({ cwd: "/repo", markdown: "[folder](docs) [file](README.md)" }));
  await page.getByRole("link", { name: "folder", exact: true }).click();
  await page.getByRole("link", { name: "file", exact: true }).click();
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith("/repo/README.md"));
  resolveFolder({ path: "/repo/docs", kind: "directory", workspaceRelativePath: "docs" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(useExplorerRevealRequestStore.getState().requestsByThreadId).toEqual({});
  expect(openInEditor).not.toHaveBeenCalled();
});

it("cancels pending opens when the chat scope changes", async () => {
  let resolveFolder!: (result: FilesystemStatResult) => void;
  stat.mockReturnValue(
    new Promise((resolve) => {
      resolveFolder = resolve;
    }),
  );
  const screen = await render(
    view({ cwd: "/repo", markdown: "[folder](docs)", scopeKey: "first" }),
  );
  await page.getByRole("link", { name: "folder", exact: true }).click();
  await screen.rerender(view({ cwd: "/repo", markdown: "Another chat", scopeKey: "next" }));
  resolveFolder({ path: "/repo/docs", kind: "directory", workspaceRelativePath: "docs" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(useExplorerRevealRequestStore.getState().requestsByThreadId).toEqual({});
  expect(openFile).not.toHaveBeenCalled();
});

it("reports access errors instead of treating the target as a file", async () => {
  const notify = vi.spyOn(toastManager, "add");
  stat.mockRejectedValue(new Error("Access denied"));
  await render(view({ cwd: "/repo", markdown: "[folder](private)" }));
  await page.getByRole("link", { name: "folder", exact: true }).click();
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ description: "Access denied" })),
  );
  expect(openFile).not.toHaveBeenCalled();
  expect(openInEditor).not.toHaveBeenCalled();
});

it("does not probe web URLs or turn unsafe schemes into local file links", async () => {
  await render(
    view({
      cwd: "/repo",
      markdown: "[website](https://example.com/docs) [unsafe](javascript:alert%281%29)",
    }),
  );
  const website = page.getByRole("link", { name: "website", exact: true });
  await expect.element(website).toHaveAttribute("href", "https://example.com/docs");
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(stat).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
});
