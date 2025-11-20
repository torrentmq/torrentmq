import { TorrentError } from "./torrent-error";
import { TorrentSignalHandler, TorrentSignalMessage } from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentSignaller {
  private ws?: WebSocket;
  private utils: TorrentUtils = new TorrentUtils();

  readonly identifier: string = this.utils.random_string();
  readonly url: string;
  readonly token?: string;
  on_message?: TorrentSignalHandler;

  constructor() {
    // NOTE: Port for connection is 32625
    this.url = this.get_ws_url();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) resolve();
      if (this.url) {
        this.ws = new WebSocket(this.url);

        if (this.ws) {
          this.ws.onerror = () => reject();
          this.ws.onopen = () => {
            const ident = { type: "SIGNALLER", identifier: this.identifier };
            if (this.ws && this.ws.readyState === WebSocket.OPEN)
              this.ws.send(JSON.stringify(ident));
            resolve();
          };
          this.ws.onmessage = (ev) => this._handle_ws_message(ev.data);
          this.ws.onclose = () => {
            this.ws = undefined;
          };
        }
      }
    });
  }

  send(msg: TorrentSignalMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new TorrentError("TorrentSignaller not connected");
    }
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws?.close();
    this.ws = undefined;
  }

  private _handle_ws_message(raw: any) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (this.on_message) this.on_message(parsed as TorrentSignalMessage);
    } catch (e) {
      throw new TorrentError(`Invalid signalling message: ${raw}`);
    }
  }

  private get_ws_url() {
    // NOTE: Port for connection is 32625
    const port = 32625;
    const is_secure = window.location.protocol === "https:";
    const host = window.location.hostname;
    return `${is_secure ? "wss" : "ws"}://${host}:${port}/ws`;
  }
}
