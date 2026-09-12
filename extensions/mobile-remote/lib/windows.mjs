import { execFileSync } from "node:child_process";

export function powershell(script, environment = {}) {
  return execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, "utf16le").toString("base64"),
  ], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// chmod does not restrict Windows ACLs. Check before reading or writing credentials.
export function assertPrivateWindowsPath(path) {
  powershell(`
    $item = Get-Item -LiteralPath $env:SYNARA_MOBILE_PRIVATE_PATH -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private path is a reparse point' }
    $acl = Get-Acl -LiteralPath $item.FullName
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $sid.Value) { throw 'Private path belongs to another user' }
    $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.Sddl)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'Private path has no DACL' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        throw 'Private path is accessible by other users; use a private directory under your user profile'
      }
    }
  `, { SYNARA_MOBILE_PRIVATE_PATH: path });
}
