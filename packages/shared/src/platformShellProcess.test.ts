import { describe, expect, it } from "vitest";
import { prepareShellProcess } from "./platformProcess";

describe("explicit shell process planning", () => {
  it("preserves POSIX shell syntax as one argument and uses the supplied environment", () => {
    const command = 'printf "%s" "$VALUE" | cat';
    expect(
      prepareShellProcess(command, { platform: "linux", env: { SHELL: "/bin/sh" } }),
    ).toMatchObject({
      command: "/bin/sh",
      args: ["-lc", command],
      shell: false,
      executionBackend: "native",
    });
  });

  it("keeps quotes and operators intact for the Windows command interpreter", () => {
    const command = '"C:\\Program Files\\tool.exe" "a b" && echo %VALUE%';
    expect(
      prepareShellProcess(command, {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      }),
    ).toMatchObject({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      executionBackend: "native",
    });
  });

  it("uses the Linux shell for a WSL workspace instead of attempting to run cmd inside WSL", () => {
    const plan = prepareShellProcess("pwd && printf ready", {
      platform: "win32",
      cwd: "\\\\wsl.localhost\\Ubuntu\\home\\project",
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(plan).toMatchObject({
      args: [
        "--distribution",
        "Ubuntu",
        "--cd",
        "/home/project",
        "--exec",
        "/bin/bash",
        "-lc",
        "pwd && printf ready",
      ],
      executionBackend: "wsl",
      shell: false,
      windowsHide: true,
    });
    expect(plan.windowsVerbatimArguments).toBeUndefined();
  });
});
