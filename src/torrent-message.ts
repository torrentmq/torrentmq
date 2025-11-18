import { TorrentUtils } from "./torrent-utils";
import {
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentMessageProperties,
} from "./torrent-types";

export class TorrentMessage {
  private utils: TorrentUtils = new TorrentUtils();
  private encoder: TextEncoder = new TextEncoder();
  properties: TorrentMessageProperties;
  body: TorrentMessageBody = null;

  constructor(message_body: TorrentMessageBody, params?: TorrentMessageParams) {
    this.body = message_body;

    this.properties = {
      message_id: this.utils.random_string(),
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
