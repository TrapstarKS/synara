# Checkpoint exclusions

Checkpoints capture workspace changes for review and Undo. Generated reports,
installers and recovery output should not make every agent message wait while Git
hashes files unrelated to the source being edited.

## Generated folders

The repository-root `Artifacts/` tree is reserved for generated output and is
excluded regardless of letter case, including files already in the index. This
preserves the existing checkpoint convention. The root names `artefacts`,
`.artifacts`, `.artefacts`, `artifacts-<suffix>` and `artefacts-<suffix>` are also
recognized without regard to letter case. A suffix starts with a letter or digit
and can contain letters, digits, dots, underscores and hyphens. These additional
variants are excluded automatically only when they are directories without files
in the current index or HEAD. Nested source paths such as `src/artifacts.ts` are
not excluded by name.

The repository's normal Git ignore rules continue to apply to untracked files.
Already tracked files in an otherwise ignored folder remain checkpointed unless
the folder is reserved or explicitly excluded below.

## Custom output paths

Run these commands in the project to declare additional output locations:

```bash
git config --local --add synara.checkpointExcludePath "qa-output"
git config --local --add synara.checkpointExcludePath "reports/rendered previews"
```

Each value is a literal path relative to the repository root. It is not a glob:
spaces and square brackets name the actual path. Absolute paths, traversal and
Git administration paths are refused. This setting affects Synara checkpoints;
it does not change which files ordinary Git commits include. An explicit rule
can exclude tracked output, so declare only paths that do not need checkpoint
recovery.

To inspect or remove the project's custom rules:

```bash
git config --local --get-all synara.checkpointExcludePath
git config --local --unset-all synara.checkpointExcludePath
```

## Restore and Undo

Each new checkpoint records its effective excluded paths in its commit metadata.
Restore combines the saved exclusions with the current policy. Diffs and Undo
combine both checkpoints' exclusions with the current policy. Removing a setting
therefore does not turn an intentionally omitted output into a file to delete.
Invalid saved policy metadata is an error, rather than permission to restore
with an empty exclusion list.

Capture stages into its own temporary index and preserves the user's real index.
Restore and Undo retain their normal behavior for managed source files, including
the existing staging/reset operations. Excluded files are left in place; these
features do not clean up disk space or delete old artifacts.

## Slow or unavailable Git storage

Repository detection and capture share the 10-second pre-send deadline. Permission
errors, lack of disk space and a stalled repository probe leave the agent free to
start after the failed baseline attempt. They do not create a valid checkpoint or
repair operating-system permissions. The failure remains available in diagnostics
and a turn may have no recoverable pre-send baseline.
