export class LangfuseApiError extends Error {
  override readonly name: string = "LangfuseApiError";
  readonly status: number;
  /**
   * What to do about it, kept separate from `message`. The message says what
   * happened; the remedy is the half a model should act on, and `fail()` lifts
   * it to a top-level field so it is not buried inside the upstream envelope.
   */
  readonly remedy: string | undefined;
  readonly errors: unknown;

  constructor(message: string, opts: { status: number; remedy?: string; errors?: unknown }) {
    super(message);
    this.status = opts.status;
    this.remedy = opts.remedy;
    this.errors = opts.errors;
  }
}

/**
 * The key works, but it belongs to a different project than the one it is
 * filed under. Raised before any data is read, because the failure it prevents is
 * silent: the wrong project answers every query with plausible, wrong data.
 */
export class ProjectMismatchError extends Error {
  override readonly name = "ProjectMismatchError";
  readonly remedy: string;

  constructor(expected: string, actual: { id: string; name: string }) {
    super(
      `The API key configured for "${expected}" belongs to Langfuse project ` +
        `"${actual.name}" (${actual.id}). Nothing was read.`,
    );
    this.remedy =
      `Langfuse keys are project-scoped. Give "${expected}" its own project's key pair ` +
      `(re-run \`pnpm provision\`, or Project Settings → API Keys), or rename the entry to ` +
      `"${actual.name}" if that is the project you meant.`;
  }
}

/** Thrown when a write path is reached while LANGFUSE_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set LANGFUSE_ALLOW_WRITES=1 to enable mutating requests.`,
    );
  }
}
