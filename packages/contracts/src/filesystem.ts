import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemStatInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});
export type FilesystemStatInput = typeof FilesystemStatInput.Type;

export const FilesystemStatResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory", "other", "missing"]),
  workspaceRelativePath: Schema.NullOr(Schema.String),
});
export type FilesystemStatResult = typeof FilesystemStatResult.Type;
