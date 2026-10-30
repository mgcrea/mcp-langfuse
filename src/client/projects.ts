import type { LangfuseClient } from "#/client/langfuse";

export type ProjectHandle = { name: string; client: LangfuseClient };

/**
 * One client per configured project, by name. A Langfuse key reads exactly one
 * project, so serving several projects means holding several keys, and every
 * data tool says which one it means.
 */
export class ProjectRegistry {
  readonly names: string[];
  private readonly byName: Map<string, LangfuseClient>;

  constructor(handles: ProjectHandle[]) {
    this.byName = new Map(handles.map((h) => [h.name, h.client]));
    this.names = handles.map((h) => h.name);
  }

  get size(): number {
    return this.names.length;
  }

  handles(): ProjectHandle[] {
    return [...this.byName].map(([name, client]) => ({ name, client }));
  }

  /**
   * The client for `name`. With a single project the name may be left out;
   * with several it may not — there is no default, because a silently chosen
   * project is the exact failure this server exists to prevent.
   */
  resolve(name: string | undefined): ProjectHandle {
    if (name === undefined) {
      const [only] = this.names;
      if (this.size === 1 && only !== undefined)
        return { name: only, client: this.byName.get(only)! };
      throw new Error(`Say which project to read: one of ${this.names.join(", ")}.`);
    }
    const client = this.byName.get(name);
    if (!client)
      throw new Error(`Unknown project "${name}". Configured: ${this.names.join(", ")}.`);
    return { name, client };
  }
}
