// Provided by the Workers runtime. Declared here so the gateway's public types
// don't depend on `@cloudflare/workers-types`.
declare module 'cloudflare:workers' {
  export type WorkflowEvent<T> = { payload: Readonly<T> }
  export abstract class WorkflowEntrypoint<E = unknown, T = unknown> {
    protected env: E
    abstract run(event: WorkflowEvent<T>, step: unknown): Promise<unknown>
  }
}
