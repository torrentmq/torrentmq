import { TorrentUtils } from "./torrent-utils";
import {
  TorrentAckCallback,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentMessageProperties,
} from "./torrent-types";
import package_json from "../package.json" with { type: "json" };

export class TorrentMessage {
  properties: TorrentMessageProperties;
  on_ack?: TorrentAckCallback;
  body: TorrentMessageBody = null;

  constructor(body: TorrentMessageBody, params?: TorrentMessageParams) {
    this.body = body;
    this.on_ack = params?.on_ack;
    this.properties = {
      headers: {
        hop_count: 0,
        source: params?.source,
        schema_version: package_json.version,
        retry_count: 0,
        re_delivered: false,
      },
      routing_key: params?.routing_key,
      content_type: typeof body,
      message_id: TorrentUtils.random_string({ max_length: 32 }),
      body_size: TorrentUtils.compute_body_size(body),
      ttl: params?.ttl,
    };
  }
}
