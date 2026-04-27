import { TorrentError } from "./torrent-error";

export class TorrentEmitter<TEvent extends string> {
  // map emittable events to a set of function
  private _events: Map<TEvent, Set<(data: any) => void>> = new Map();

  constructor() {}

  on<T>(event: TEvent, listener: (data: T) => void): void;

  on(event: Partial<Record<TEvent, (data: any) => void>>): void;

  on<T>(
    event: TEvent | Partial<Record<TEvent, (data: T) => void>>,
    listener?: (data: T) => void,
  ) {
    if (typeof event === "object") {
      for (const [evt, fn] of Object.entries(event)) {
        if (typeof fn === "function")
          this.on(evt as TEvent, fn as (data: any) => void);
      }
      return;
    }

    if (!listener) {
      throw new TorrentError(`Handler must be provided for event: ${event}`);
    }

    if (!this._events.has(event)) {
      this._events.set(event, new Set());
    }

    this._events.get(event)!.add(listener);
  }

  protected emit<T>(event: TEvent, payload?: T) {
    const handlers = this._events.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(payload);
      } catch (err) {
        console.warn("Error in event handler for", event, err);
      }
    }
  }
}
