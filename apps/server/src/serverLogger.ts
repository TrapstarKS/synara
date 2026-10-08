import { RotatingFileSink } from "@synara/shared/logging";
import { Effect, Logger } from "effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config";
import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  PRIVATE_FILE_MODE,
} from "./privatePathPermissions";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILES = 3;

export const ServerLoggerLive = Effect.gen(function* () {
  const { logsDir, serverLogPath } = yield* ServerConfig;

  const sink = yield* Effect.sync(() => {
    ensurePrivateDirectorySync(logsDir);
    ensurePrivateFileSync(serverLogPath);
    return new RotatingFileSink({
      filePath: serverLogPath,
      maxBytes: MAX_LOG_BYTES,
      maxFiles: MAX_LOG_FILES,
      mode: PRIVATE_FILE_MODE,
    });
  });

  const fileLogger = yield* Logger.batched(Logger.formatSimple, {
    window: 1000,
    flush: (messages) =>
      Effect.sync(() => {
        for (const message of messages) {
          const buffer = Buffer.from(`${message}\n`);
          // Split oversized records so they cannot bypass the per-file limit.
          for (let offset = 0; offset < buffer.length; offset += MAX_LOG_BYTES) {
            sink.write(buffer.subarray(offset, offset + MAX_LOG_BYTES));
          }
        }
      }),
  });

  return Logger.layer([Logger.defaultLogger, fileLogger], {
    mergeWithExisting: false,
  });
}).pipe(Layer.unwrap);
