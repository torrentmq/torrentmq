import { TORRENT_PORT } from "./torrent-consts";
import { TorrentEmitter } from "./torrent-emitter";
import { TorrentError } from "./torrent-error";
import {
  TorrentSignalEventMessage,
  TorrentSignalMessage,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentSignaller extends TorrentEmitter<
  "message" | "error" | "open" | "close"
> {
  private socket?: WebSocket;
  private identifier: string = TorrentUtils.random_string();

  constructor() {
    super();
  }

  connect(server_url?: string) {
    const { is_secure, default_url } = this.default_socket_url();

    if (server_url) {
      if (!/^wss?:\/\//.test(server_url)) {
        throw new TorrentError(
          `Invalid WebSocket URL protocol. Expected: ws:// or wss://. Received: ${server_url}`,
        );
      }

      if (is_secure && !server_url.startsWith("wss://")) {
        throw new TorrentError(
          `Insecure WebSocket URL detected. This application is running over HTTPS, so a secure WebSocket (wss://) is required. Received: ${server_url}`,
        );
      }
    }

    const resolved_url = server_url ?? default_url;

    if (
      this.socket &&
      this.socket.readyState === WebSocket.OPEN &&
      this.socket.url === resolved_url
    )
      return;

    if (resolved_url) {
      this.socket = new WebSocket(resolved_url);

      if (this.socket) {
        this.socket.onerror = (ev) =>
          this.emit<TorrentError>(
            "error",
            new TorrentError(`WebSocket error: ${ev}`),
          );
        this.socket.onopen = () => {
          if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const msg: TorrentSignalEventMessage = {
              type: "SIGNALLER_CONNECTED",
              ident: this.identifier,
              url: resolved_url,
            };

            this.emit<TorrentSignalEventMessage>("open", msg);
          }
        };
        this.socket.onmessage = (ev) => this._handle_socket_message(ev.data);
        this.socket.onclose = () => {
          this.socket = undefined;
          const msg: TorrentSignalEventMessage = {
            type: "SIGNALLER_DISCONNECTED",
            ident: this.identifier,
            url: resolved_url,
          };

          this.emit<TorrentSignalEventMessage>("close", msg);
        };
      }
    }
  }

  get_identifier() {
    return this.identifier;
  }

  send(msg: TorrentSignalMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new TorrentError("TorrentSignaller not connected");
    }
    this.socket.send(JSON.stringify(msg));
  }

  close() {
    this.socket?.close();
    this.socket = undefined;
  }

  private _handle_socket_message(raw: any) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      this.emit<TorrentSignalMessage>(
        "message",
        parsed as TorrentSignalMessage,
      );
    } catch (e) {
      throw new TorrentError(`Invalid signalling message: ${raw}`);
    }
  }

  private default_socket_url() {
    // NOTE: default port for connection is 6767
    const { host, is_secure } = TorrentUtils.security_and_host();

    return {
      is_secure,
      default_url: `${is_secure ? "wss" : "ws"}://${host}:${TORRENT_PORT}/ws`,
    };
  }
}
