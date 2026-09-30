import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powershell } from "./windows.mjs";

// Windows CI's shared TEMP directory has a broad inherited ACL. Restrict only
// each freshly-created fixture before tests put synthetic credentials in it;
// the production privacy checks remain enabled and unchanged.
export function createPrivateFixtureDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    if (process.platform === "win32") {
      powershell(
        `
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $env:SYNARA_TEST_PRIVATE_DIRECTORY -AclObject $acl
        `,
        { SYNARA_TEST_PRIVATE_DIRECTORY: directory },
      );
    } else {
      chmodSync(directory, 0o700);
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
