import { TorrentUtils } from "./torrent-utils";
import {
  TorrentAckCallBack,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentMessageProperties,
} from "./torrent-types";

export class TorrentMessage {
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
      body_size: TorrentUtils.compute_body_size(message_body),

      headers: {
        hop_count: 0,
        retry_count: 0,
        content_type: typeof message_body,
      },
    };
  }
}
