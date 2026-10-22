// A vitest reporter for run.ts: vitest's JSON report leaves out the errors no test owned (an
// unhandled rejection in a suite, a harness that failed after its test ended), so this one writes
// them to the file CELLD_INTEGRATION_UNHANDLED names, one message each.

import { writeFileSync } from "node:fs";

export default class UnhandledErrorsReporter {
  onTestRunEnd(_testModules: unknown, unhandledErrors: readonly unknown[] = []): void {
    const path = process.env.CELLD_INTEGRATION_UNHANDLED;
    if (!path) throw new Error("CELLD_INTEGRATION_UNHANDLED is not set; run.ts sets it");
    const messages = unhandledErrors.map(error =>
      error instanceof Error ? `${error.name}: ${error.message}`
        : typeof error === "object" && error !== null && "message" in error ? String(error.message)
        : String(error));
    writeFileSync(path, JSON.stringify(messages, null, 2) + "\n");
  }
}
