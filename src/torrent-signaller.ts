import { TorrentUtils } from "./torrent-utils";
import { TORRENT_PORT } from "./torrent-consts";
import { TorrentError } from "./torrent-error";
import { TorrentEmitter } from "./torrent-emitter";
import type {
  TorrentWebSocketUrl,
  TorrentSignalMessage,
} from "./torrent-types";

export class TorrentSignaller extends TorrentEmitter<
  "message" | "error" | "open" | "close"
> {
  private socket?: WebSocket;
  private readonly identifier: string = TorrentUtils.random_string();

  constructor() {
    super();
  }

  connect(server_url?: TorrentWebSocketUrl) {
    const { is_secure, default_url } = this.default_socket_url();
    const url = server_url ?? default_url;

    if (is_secure && !url.startsWith("wss://"))
      throw new TorrentError(
        `Insecure WebSocket URL detected. This application is running over HTTPS, so a secure WebSocket (wss://) is required. Received: ${server_url}`,
      );

    if (this.socket)
      if (url !== this.socket.url) this.disconnect();
      else return;

    this.socket = new WebSocket(url);

    // event handlers
    this.socket.onerror = (ev) =>
      this.emit<TorrentError>(
        "error",
        new TorrentError(`WebSocket error: ${ev}`),
      );

    this.socket.onopen = () => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN)
        this.emit("open");
    };

    this.socket.onmessage = (ev) => this._handle_socket_message(ev.data);

    this.socket.onclose = () => {
      this.emit("close");
      this.socket = undefined;
    };
  }

  disconnect() {
    this.socket?.close();
    this.socket = undefined;
  }

  send(msg: TorrentSignalMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new TorrentError("TorrentSignaller not connected");
    }
    this.socket.send(JSON.stringify(msg));
  }

  private default_socket_url() {
    const { host, secure } = TorrentUtils.security_and_host();

    return {
      is_secure: secure,
      default_url: `${secure ? "wss" : "ws"}://${host}:${TORRENT_PORT}/ws`,
    };
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
}
