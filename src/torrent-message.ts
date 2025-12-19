import { TorrentUtils } from "./torrent-utils";
import {
  TorrentAckCallBack,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentMessageProperties,
} from "./torrent-types";

export class TorrentMessage {
  private encoder: TextEncoder = new TextEncoder();
  properties: TorrentMessageProperties;
  on_ack?: TorrentAckCallBack;
  body: TorrentMessageBody = null;

  constructor(message_body: TorrentMessageBody, params?: TorrentMessageParams) {
    this.body = message_body;

    this.on_ack = params?.on_ack;

    this.properties = {
      message_id: TorrentUtils.random_string(),
      routing_key: params?.routing_key,
      re_delivered: false,
      body_size: this._compute_body_size(message_body),

      headers: {
        hop_count: 0,
        retry_count: 0,
        content_type: typeof message_body,
      },
    };
  }

  private _compute_body_size(body: TorrentMessageBody): number {
    if (body === null) return 0;

    if (body instanceof Uint8Array) {
      return body.byteLength;
    }

    switch (typeof body) {
      case "string":
        return this.encoder.encode(body).byteLength;

      case "number":
      case "boolean":
        return this.encoder.encode(String(body)).byteLength;

      case "object":
        return this.encoder.encode(JSON.stringify(body)).byteLength;

      default:
        return 0;
    }
  }
}
