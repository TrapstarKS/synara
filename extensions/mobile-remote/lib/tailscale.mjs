import { execFile } from "node:child_process";
import dns from "node:dns";

// GUI apps and login tasks often lack the CLI on PATH.
const candidates =
  process.platform === "win32"
    ? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]
    : [
        "tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ];
const desktopOs = new Set(["windows", "macOS", "linux"]);

export async function tailscale(args, run = execFile) {
  for (const command of candidates) {
    try {
      return await new Promise((resolve, reject) =>
        run(command, args, { timeout: 10_000, windowsHide: true }, (error, stdout) =>
          error ? reject(error) : resolve(String(stdout)),
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Tailscale CLI not found");
}

const dnsName = (name) => String(name ?? "").replace(/\.$/, "");

/** This node's MagicDNS name, owner login, and the owner's other online computers. */
export function parseStatus(status) {
  const self = status.Self;
  if (!self?.DNSName) throw new Error("Tailscale is not connected");
  return {
    dnsName: dnsName(self.DNSName),
    name: String(self.HostName ?? "").slice(0, 40),
    login: status.User?.[self.UserID]?.LoginName,
    computers: Object.values(status.Peer ?? {})
      .filter(
        (peer) =>
          peer.Online && peer.UserID === self.UserID && desktopOs.has(peer.OS) && peer.DNSName,
      )
      .map((peer) => ({
        name: String(peer.HostName).slice(0, 40),
        dnsName: dnsName(peer.DNSName),
        ip: peer.TailscaleIPs?.[0],
      })),
  };
}

const tailnetAddresses = new Map();
const systemLookup = dns.lookup;
/**
 * Resolves peer MagicDNS names to their Tailscale IPs, so peers stay reachable
 * when this computer runs with `tailscale set --accept-dns=false`. TLS still
 * verifies the MagicDNS name because only the socket address changes.
 */
export function routeTailnetNames(computers) {
  for (const computer of computers)
    if (computer.ip) tailnetAddresses.set(computer.dnsName.toLowerCase(), computer.ip);
  if (dns.lookup !== systemLookup) return;
  dns.lookup = function (host, options, callback) {
    const address = tailnetAddresses.get(String(host).toLowerCase());
    return systemLookup.call(this, address ?? host, options, callback);
  };
}

export async function tailnetStatus(run) {
  const status = parseStatus(JSON.parse(await tailscale(["status", "--json"], run)));
  routeTailnetNames(status.computers);
  return status;
}

/** Serves the companion on HTTPS :httpsPort unless that port already has another route. */
export async function ensureServe(port, httpsPort, run) {
  const status = JSON.parse((await tailscale(["serve", "status", "--json"], run)) || "{}");
  const routes = Object.entries(status.Web ?? {}).filter(([host]) =>
    host.endsWith(`:${httpsPort}`),
  );
  if (status.TCP?.[httpsPort] || routes.length)
    return routes.some(([, web]) => web.Handlers?.["/"]?.Proxy === `http://127.0.0.1:${port}`)
      ? "ready"
      : "occupied";
  await tailscale(["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`], run);
  return "configured";
}
