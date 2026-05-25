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
  private transport?: WebTransport;
  private stream?: WebTransportBidirectionalStream;
  private socket?: WebSocket;

  private is_connected: boolean = false;
  private type?: "web_socket" | "web_transport";
  private identifier: string = TorrentUtils.random_string();

  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor() {
    super();
  }

  async connect(options: {
    server_url?: string;
    type?: "web_socket" | "web_transport";
  }) {
    const { server_url, type } = options;
    const { is_secure, default_socket_url, default_transport_url } =
      this.default_socket_url();

    if (server_url) {
      const is_ws = /^wss?:\/\//.test(server_url);
      const is_http = /^https?:\/\//.test(server_url);

      if (!is_ws && !is_http) {
        throw new TorrentError(
          `Invalid URL protocol. Expected: ws://, wss://, http:// or https://. Received: ${server_url}`,
        );
      }

      if (
        is_secure &&
        (server_url.startsWith("ws://") || server_url.startsWith("http://"))
      ) {
        throw new TorrentError(
          `Insecure URL detected. This application is running over HTTPS, so a secure URL is required. Received: ${server_url}`,
        );
      }
    }

    const resolved_url =
      server_url ??
      (!type || type === "web_transport"
        ? default_transport_url
        : default_socket_url);

    const temp_type =
      type ??
      (resolved_url.startsWith("wss://") || resolved_url.startsWith("ws://")
        ? "web_socket"
        : "web_transport");

    if (temp_type !== this.type) {
      this.close();
      this.type = temp_type;
    }

    this.is_connected = true;

    if (this.type === "web_transport") {
      this.transport = new WebTransport(resolved_url);

      this.transport.ready
        .then(() => {
          const msg: TorrentSignalEventMessage = {
            type: "SIGNALLER_CONNECTED",
            ident: this.identifier,
            url: resolved_url,
          };
          this.emit<TorrentSignalEventMessage>("open", msg);
        })
        .catch((e) =>
          this.emit<TorrentError>(
            "error",
            new TorrentError(`WebTransport ready error: ${e}`),
          ),
        );

      this.transport.closed
        .then(() => {
          this.cleanup_transport_states();
          const msg: TorrentSignalEventMessage = {
            type: "SIGNALLER_DISCONNECTED",
            ident: this.identifier,
            url: resolved_url,
          };
          this.emit<TorrentSignalEventMessage>("close", msg);
        })
        .catch((e) => {
          this.cleanup_transport_states();
          this.emit<TorrentError>(
            "error",
            new TorrentError(`WebTransport closed with error: ${e}`),
          );
        });

      try {
        this.stream = await this.transport.createBidirectionalStream();
        this._listen_to_transport_stream(this.stream.readable);
      } catch (e) {
        throw new TorrentError(`Failed to establish WebTransport stream: ${e}`);
      }
    } else {
      this.socket = new WebSocket(resolved_url);

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
        this.is_connected = false;
        const msg: TorrentSignalEventMessage = {
          type: "SIGNALLER_DISCONNECTED",
          ident: this.identifier,
          url: resolved_url,
        };
        this.emit<TorrentSignalEventMessage>("close", msg);
      };
    }
  }

  async send(msg: TorrentSignalMessage) {
    if (!this.is_connected) {
      throw new TorrentError("TorrentSignaller not connected");
    }

    if (this.type === "web_socket") {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
        throw new TorrentError("WebSocket is not open");

      this.socket.send(JSON.stringify(msg));
    } else {
      if (!this.stream)
        throw new TorrentError("WebTransport stream is not available");

      const writer = this.stream.writable.getWriter();
      try {
        await writer.write(
          this.encoder.encode(
            TorrentUtils.to_base64_url(TorrentUtils.to_array_buffer(msg)),
          ),
        );
      } finally {
        writer.releaseLock();
      }
    }
  }

  close() {
    this.is_connected = false;

    this.transport?.close();
    this.cleanup_transport_states();

    this.socket?.close();
    this.socket = undefined;
  }

  private cleanup_transport_states() {
    this.stream = undefined;
    this.transport = undefined;
  }

  private async _listen_to_transport_stream(readable: ReadableStream) {
    const reader = readable.getReader();
    try {
      while (this.is_connected) {
        const { value, done } = await reader.read();
        if (done) break;

        if (value) {
          const decodedString = this.decoder.decode(value);
          const parsed = TorrentUtils.from_array_buffer(
            TorrentUtils.from_base64_url(decodedString),
          );

          this.emit<TorrentSignalMessage>(
            "message",
            parsed as TorrentSignalMessage,
          );
        }
      }
    } catch (e) {
      this.emit<TorrentError>(
        "error",
        new TorrentError(`Error reading WebTransport stream: ${e}`),
      );
    } finally {
      reader.releaseLock();
    }
  }

  private _handle_socket_message(raw: any) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      this.emit<TorrentSignalMessage>(
        "message",
        parsed as TorrentSignalMessage,
      );
    } catch (e) {
      this.emit<TorrentError>(
        "error",
        new TorrentError(`Invalid signalling message: ${raw}`),
      );
    }
  }

  private default_socket_url() {
    const { host, is_secure } = TorrentUtils.security_and_host();

    return {
      is_secure,
      default_socket_url: `${is_secure ? "wss" : "ws"}://${host}:${TORRENT_PORT}/ws`,
      default_transport_url: `${is_secure ? "https" : "http"}://${host}:${TORRENT_PORT}/wt`,
    };
  }
}
