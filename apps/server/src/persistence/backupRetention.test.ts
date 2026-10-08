import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANUAL_BACKUP_MAX_AGE_MS,
  MANUAL_BACKUP_RETENTION,
  MIGRATION_BACKUP_RETENTION,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  pruneDatabaseBackups,
  reclaimOrphanedMigrationArtifacts,
} from "./MigrationBackup.ts";

const NOW = Date.UTC(2026, 9, 8, 12);
const tempDirectories: Array<string> = [];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-backup-retention-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

function migrationName(dbPath: string, day: number): string {
  return `${path.basename(dbPath)}.pre-migration-v52-to-v53-202610${`${day}`.padStart(2, "0")}T120000000Z-${randomUUID()}.sqlite`;
}

async function writeBackups(dbPath: string, names: ReadonlyArray<string>): Promise<void> {
  const directory = migrationBackupDirectory(dbPath);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(
    names.map(async (name, index) => {
      const filePath = path.join(directory, name);
      await fs.writeFile(filePath, "snapshot");
      const inverted = new Date(NOW - index * 60_000);
      await fs.utimes(filePath, inverted, inverted);
    }),
  );
}

async function namesIn(dbPath: string): Promise<Array<string>> {
  return (await fs.readdir(migrationBackupDirectory(dbPath))).toSorted();
}

async function writeRecord(
  dbPath: string,
  recordPath: string,
  backupName: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const text = JSON.stringify({
    version: 1,
    databasePath: dbPath,
    backupPath: path.join(migrationBackupDirectory(dbPath), backupName),
    sourceVersion: "v52",
    targetVersion: 53,
    resumeAttempts: 0,
    ...extra,
  });
  await fs.writeFile(recordPath, text);
  return text;
}

describe("database backup retention", () => {
  it("prunes existing migration backups on startup using filename timestamps", async () => {
    const dbPath = await makeDbPath();
    const backups = [1, 2, 3, 4].map((day) => migrationName(dbPath, day));
    await writeBackups(dbPath, backups);
    await fs.writeFile(dbPath, "live database");
    await fs.writeFile(`${dbPath}-wal`, "live WAL");

    await Effect.runPromise(reclaimOrphanedMigrationArtifacts(dbPath));

    expect(await namesIn(dbPath)).toEqual(backups.slice(-MIGRATION_BACKUP_RETENTION).toSorted());
    expect(await fs.readFile(dbPath, "utf8")).toBe("live database");
    expect(await fs.readFile(`${dbPath}-wal`, "utf8")).toBe("live WAL");
  });

  it("shares the manual retention bound across recognized manual filename forms", async () => {
    const dbPath = await makeDbPath();
    const manuals = [
      "manual-pre-cleanup-20261001.sqlite",
      `${path.basename(dbPath)}.manual-backup-20261002T1200.sqlite`,
      `${path.basename(dbPath)}.manual-backup-20261003T120000000Z-${randomUUID()}.sqlite`,
      "manual-pre-cleanup-20261007.sqlite",
    ];
    await writeBackups(dbPath, manuals);

    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(await namesIn(dbPath)).toEqual(manuals.slice(-MANUAL_BACKUP_RETENTION).toSorted());
  });

  it("expires old manual backups while preserving the newest manual recovery point", async () => {
    const dbPath = await makeDbPath();
    const manuals = ["manual-pre-cleanup-20260101.sqlite", "manual-pre-cleanup-20260201.sqlite"];
    await writeBackups(dbPath, manuals);

    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(MANUAL_BACKUP_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(await namesIn(dbPath)).toEqual(manuals.slice(-1));
  });

  it("keeps a single migration and manual backup even when the manual backup is old", async () => {
    const dbPath = await makeDbPath();
    const names = [migrationName(dbPath, 1), "manual-pre-cleanup-20260101.sqlite"];
    await writeBackups(dbPath, names);

    await Effect.runPromise(pruneDatabaseBackups(dbPath));
    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(await namesIn(dbPath)).toEqual(names.toSorted());
  });

  it.each([
    { phase: "migration-in-progress", resumeAttempts: 0 },
    { phase: "migration-in-progress", resumeAttempts: 2 },
    { phase: "migration-restore-in-progress", resumeAttempts: 2 },
  ])("pins a recovery snapshot for $phase with $resumeAttempts attempts", async (state) => {
    const dbPath = await makeDbPath();
    const backups = [1, 2, 3, 4].map((day) => migrationName(dbPath, day));
    await writeBackups(dbPath, backups);
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const marker = await writeRecord(dbPath, markerPath, backups[0]!, state);
    const provenancePath = migrationBackupProvenancePath(dbPath);
    const provenance = await writeRecord(dbPath, provenancePath, backups[1]!, {
      phase: "migration-completed",
    });

    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(await namesIn(dbPath)).toEqual([backups[0]!, backups[1]!, backups[3]!].toSorted());
    expect(await fs.readFile(markerPath, "utf8")).toBe(marker);
    expect(await fs.readFile(provenancePath, "utf8")).toBe(provenance);
  });

  it.each(["{", "null", "[]", "{}", '{"resumeAttempts":-1}'])(
    "preserves finished backups when the recovery marker is malformed: %s",
    async (marker) => {
      const dbPath = await makeDbPath();
      const names = [
        ...[1, 2, 3].map((day) => migrationName(dbPath, day)),
        "manual-pre-cleanup-20260101.sqlite",
        "manual-pre-cleanup-20260201.sqlite",
        "manual-pre-cleanup-20260301.sqlite",
      ];
      await writeBackups(dbPath, names);
      await fs.writeFile(migrationRecoveryMarkerPath(dbPath), marker);

      await Effect.runPromise(pruneDatabaseBackups(dbPath));

      expect(await namesIn(dbPath)).toEqual(names.toSorted());
      expect(await fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8")).toBe(marker);
    },
  );

  it.each(["outside", "nested", "missing", "counter", "database"])(
    "preserves every finished backup when the marker has an invalid %s reference",
    async (invalid) => {
      const dbPath = await makeDbPath();
      const names = [1, 2, 3].map((day) => migrationName(dbPath, day));
      await writeBackups(dbPath, names);
      const outsidePath = path.join(path.dirname(dbPath), names[0]!);
      const nestedPath = path.join(migrationBackupDirectory(dbPath), "nested", names[0]!);
      await fs.mkdir(path.dirname(nestedPath));
      await fs.writeFile(outsidePath, "outside");
      await fs.writeFile(nestedPath, "nested");
      const invalidFields = {
        outside: { backupPath: outsidePath },
        nested: { backupPath: nestedPath },
        missing: {
          backupPath: path.join(migrationBackupDirectory(dbPath), migrationName(dbPath, 7)),
        },
        counter: { resumeAttempts: -1 },
        database: { databasePath: `${dbPath}.other` },
      }[invalid];
      await writeRecord(dbPath, migrationRecoveryMarkerPath(dbPath), names[0]!, invalidFields);

      await Effect.runPromise(pruneDatabaseBackups(dbPath));

      expect(await namesIn(dbPath)).toEqual([...names, "nested"].toSorted());
      expect(await fs.readFile(outsidePath, "utf8")).toBe("outside");
      expect(await fs.readFile(nestedPath, "utf8")).toBe("nested");
    },
  );

  it("preserves finished backups when completed provenance cannot be validated", async () => {
    const dbPath = await makeDbPath();
    const names = [1, 2, 3].map((day) => migrationName(dbPath, day));
    await writeBackups(dbPath, names);
    await fs.writeFile(migrationBackupProvenancePath(dbPath), "{}");

    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(await namesIn(dbPath)).toEqual(names.toSorted());
  });

  it("retains unknown filenames and impossible timestamps without ranking them", async () => {
    const dbPath = await makeDbPath();
    const backups = [1, 2, 3].map((day) => migrationName(dbPath, day));
    const unknown = [
      "notes.sqlite",
      "manual-pre-cleanup-unknown.sqlite",
      "manual-pre-cleanup-20260230.sqlite",
      "manual-pre-cleanup-20260931.sqlite",
      "other.sqlite.manual-backup-20261001T120000000Z.sqlite",
      `${path.basename(dbPath)}.manual-backup-20261001T120000000Z-unrecognized.sqlite`,
      `${path.basename(dbPath)}.pre-migration-v52-to-v53-20261001T120000000Z-unrecognized.sqlite`,
      `${path.basename(dbPath)}.pre-migration-v52-to-v53-20260230T120000000Z-${randomUUID()}.sqlite`,
      `${path.basename(dbPath)}.pre-migration-v20260101T1200-to-v53-20260230T120000000Z-${randomUUID()}.sqlite`,
    ];
    await writeBackups(dbPath, [...backups, ...unknown]);

    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(await namesIn(dbPath)).toEqual([...backups.slice(-1), ...unknown].toSorted());
  });

  it("never prunes recognized names outside the adjacent backup directory or in nested directories", async () => {
    const dbPath = await makeDbPath();
    const backups = [1, 2, 3].map((day) => migrationName(dbPath, day));
    await writeBackups(dbPath, backups);
    const outsidePath = path.join(path.dirname(dbPath), backups[0]!);
    const nestedDirectory = path.join(migrationBackupDirectory(dbPath), "nested");
    const namedDirectory = path.join(
      migrationBackupDirectory(dbPath),
      "manual-pre-cleanup-20260101.sqlite",
    );
    await fs.mkdir(nestedDirectory);
    await fs.mkdir(namedDirectory);
    await fs.writeFile(outsidePath, "outside");
    await fs.writeFile(path.join(nestedDirectory, backups[0]!), "nested");

    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(await namesIn(dbPath)).toEqual(
      [backups[2]!, "nested", path.basename(namedDirectory)].toSorted(),
    );
    expect(await fs.readFile(outsidePath, "utf8")).toBe("outside");
    expect(await fs.readFile(path.join(nestedDirectory, backups[0]!), "utf8")).toBe("nested");
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked backup root", async () => {
    const dbPath = await makeDbPath();
    const otherDbPath = await makeDbPath();
    const names = [1, 2, 3].map((day) => migrationName(dbPath, day));
    await writeBackups(otherDbPath, names);
    await fs.symlink(
      migrationBackupDirectory(otherDbPath),
      migrationBackupDirectory(dbPath),
      "dir",
    );

    await expect(Effect.runPromise(pruneDatabaseBackups(dbPath))).rejects.toThrow("Cleanup root");

    expect(await namesIn(otherDbPath)).toEqual(names.toSorted());
    expect((await fs.lstat(migrationBackupDirectory(dbPath))).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not follow backup or marker symlinks", async () => {
    const dbPath = await makeDbPath();
    const names = [1, 2, 3].map((day) => migrationName(dbPath, day));
    await writeBackups(dbPath, names);
    const outsidePath = path.join(path.dirname(dbPath), "outside.sqlite");
    await fs.writeFile(outsidePath, "outside");
    const backupLink = path.join(
      migrationBackupDirectory(dbPath),
      "manual-pre-cleanup-20260101.sqlite",
    );
    await fs.symlink(outsidePath, backupLink);
    const markerTarget = path.join(path.dirname(dbPath), "outside-marker.json");
    await writeRecord(dbPath, markerTarget, names[0]!);
    await fs.symlink(markerTarget, migrationRecoveryMarkerPath(dbPath));

    await Effect.runPromise(pruneDatabaseBackups(dbPath));

    expect(await namesIn(dbPath)).toEqual([...names, path.basename(backupLink)].toSorted());
    await fs.unlink(migrationRecoveryMarkerPath(dbPath));
    await Effect.runPromise(pruneDatabaseBackups(dbPath));
    expect(await namesIn(dbPath)).toEqual([names[2]!, path.basename(backupLink)].toSorted());
    expect((await fs.lstat(backupLink)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outsidePath, "utf8")).toBe("outside");
  });

  it.each([
    { migrationRetention: 0 },
    { manualRetention: 0 },
    { migrationRetention: Number.NaN },
    { manualMaxAgeMs: -1 },
  ])("rejects unsafe retention options: %j", async (options) => {
    const dbPath = await makeDbPath();
    const names = [1, 2, 3].map((day) => migrationName(dbPath, day));
    await writeBackups(dbPath, names);

    await expect(Effect.runPromise(pruneDatabaseBackups(dbPath, options))).rejects.toThrow(
      "policy",
    );

    expect(await namesIn(dbPath)).toEqual(names.toSorted());
  });
});
