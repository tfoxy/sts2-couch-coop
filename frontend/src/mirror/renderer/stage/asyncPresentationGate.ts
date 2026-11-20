/** Orders asynchronous surface presentations before scene/hit state is committed. */
export interface AsyncPresentationTicket { readonly generation: number; readonly revision: number }

export function createAsyncPresentationGate() {
  let generation = 0;
  let latestRevision = -1;
  let disposed = false;
  return {
    begin(revision: number): AsyncPresentationTicket {
      latestRevision = revision;
      generation += 1;
      return { generation, revision };
    },
    current(ticket: AsyncPresentationTicket): boolean {
      return !disposed && ticket.generation === generation && ticket.revision === latestRevision;
    },
    invalidate(revision?: number): void {
      generation += 1;
      if (revision !== undefined) latestRevision = revision;
    },
    dispose(): void {
      disposed = true;
      generation += 1;
    },
    get disposed(): boolean { return disposed; },
  };
}
