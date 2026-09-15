import { readFileSync } from "node:fs";
import { transformSync } from "@babel/core";

import { createReactCompilerCache } from "./reactCompilerCache";

interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null | undefined;
  readonly detail?:
    | { readonly reason?: string | undefined; readonly description?: string | undefined }
    | undefined;
}

const cached = createReactCompilerCache("coverage", [new URL(import.meta.url)]);

export function compileEvents(filePath: string): Promise<CompilerEvent[]> {
  const source = readFileSync(filePath, "utf8");
  return cached(filePath, source, null, () => {
    const events: CompilerEvent[] = [];
    transformSync(source, {
      filename: filePath,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [
        [
          "babel-plugin-react-compiler",
          {
            panicThreshold: "none",
            logger: {
              logEvent: (_fn: unknown, event: CompilerEvent) => {
                // Compiler error properties may live on a prototype. Cache
                // the exact fields asserted by the coverage tests.
                events.push({
                  kind: event.kind,
                  fnName: event.fnName,
                  detail: {
                    reason: event.detail?.reason,
                    description: event.detail?.description,
                  },
                });
              },
            },
          },
        ],
      ],
    });
    return events;
  });
}
