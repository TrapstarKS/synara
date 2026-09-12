import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { powershell, assertPrivateWindowsPath } from "./windows.mjs";
import { resolveServiceSettings } from "./service-config.mjs";

export const taskName = "Synara Mobile Remote";

export function windowsTaskScript(command) {
  if (!["install", "uninstall", "status"].includes(command)) throw new Error("Unknown service command");
  return `
    $name = '${taskName}'
    $task = Get-ScheduledTask | Where-Object { $_.TaskName -eq $name -and $_.TaskPath -eq '\\' }
    $arguments = '"' + $env:SYNARA_MOBILE_SERVICE_ENTRY + '" run'
    if ($task) {
      $actions = @($task.Actions)
      if ($actions.Count -ne 1 -or $actions[0].Execute -ne $env:SYNARA_MOBILE_NODE -or
          $actions[0].Arguments -ne $arguments -or $actions[0].WorkingDirectory -ne $env:SYNARA_MOBILE_REPO) {
        throw 'The existing task is not owned by this checkout and Node runtime'
      }
    }
    ${command === "status" ? `
      if ($task) { $task.State.ToString() } else { 'Not installed' }
    ` : command === "uninstall" ? `
      if ($task) {
        Stop-ScheduledTask -TaskName $name -TaskPath '\\'
        Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false
      }
    ` : `
      if ($task -and $task.State -eq 'Running') { throw 'The companion is running; uninstall it before changing its configuration' }
      $action = New-ScheduledTaskAction -Execute $env:SYNARA_MOBILE_NODE -Argument $arguments -WorkingDirectory $env:SYNARA_MOBILE_REPO
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
      Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    `}
  `;
}

export async function windowsService({ command, origin, directory, entry, repo }) {
  const configPath = join(directory, "service.json");
  if (command === "run") {
    assertPrivateWindowsPath(directory);
    assertPrivateWindowsPath(configPath);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const settings = resolveServiceSettings({ origin: config.origin, defaultMobileHome: directory });
    delete process.env.SYNARA_MOBILE_UPSTREAM;
    delete process.env.SYNARA_MOBILE_UPSTREAM_TOKEN;
    process.env.SYNARA_MOBILE_HOME = settings.mobileHome;
    process.env.SYNARA_MOBILE_ORIGIN = settings.origin;
    process.env.SYNARA_MOBILE_PORT = "58091";
    if (config.desktopHome) process.env.SYNARA_MOBILE_DESKTOP_HOME = config.desktopHome;
    await import("../server.mjs");
    return;
  }
  const environment = {
    SYNARA_MOBILE_SERVICE_ENTRY: entry, SYNARA_MOBILE_NODE: process.execPath,
    SYNARA_MOBILE_REPO: repo,
  };
  // Inspect ownership before modifying any installed configuration.
  const status = powershell(windowsTaskScript("status"), environment);
  if (command === "status") { console.log(`${taskName}: ${status}`); return; }
  if (command === "uninstall") {
    powershell(windowsTaskScript(command), environment);
    if (existsSync(configPath)) unlinkSync(configPath);
    console.log("Companion removed. Synara, saved devices and Tailscale were preserved.");
    return;
  }
  if (status === "Running") throw new Error("Uninstall the running companion before reinstalling it");
  mkdirSync(directory, { recursive: true });
  assertPrivateWindowsPath(directory);
  let previous = {};
  if (existsSync(configPath)) {
    assertPrivateWindowsPath(configPath);
    previous = JSON.parse(readFileSync(configPath, "utf8"));
  }
  const settings = resolveServiceSettings({ origin: origin ?? previous.origin, defaultMobileHome: directory });
  powershell(windowsTaskScript("install"), environment);
  writeFileSync(configPath, JSON.stringify({
    origin: settings.origin,
    desktopHome: process.env.SYNARA_MOBILE_DESKTOP_HOME || previous.desktopHome,
  }));
  powershell(`Start-ScheduledTask -TaskName '${taskName}' -TaskPath '\\'`);
  console.log("Mobile companion installed for this user's login. Run node extensions/mobile-remote/cli.mjs pair.");
}
