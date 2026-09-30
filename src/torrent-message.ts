import { TorrentUtils } from "./torrent-utils";
import type {
  TorrentAckCallback,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentMessageProperties,
} from "./torrent-types";
import package_json from "../package.json" with { type: "json" };
import { TorrentSeederContext } from "./contexts/torrent-seeder-context";
import { TorrentFurrowContext } from "./contexts/torrent-furrow-context";

export class TorrentMessage {
  ctx: TorrentSeederContext | TorrentFurrowContext;
  properties: TorrentMessageProperties;
  on_ack?: TorrentAckCallback;
  body: TorrentMessageBody = null;

  constructor(
    ctx: TorrentSeederContext | TorrentFurrowContext,
    body: TorrentMessageBody,
    params?: TorrentMessageParams,
  ) {
    this.ctx = ctx;

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

  ack(): void {
    if (this.ctx instanceof TorrentSeederContext)
      this.ctx.ctx.publish({
        type: "ACK",
        message_id: this.properties.message_id!,
        seeder: { id: this.ctx.identifier, name: this.ctx.name },
      });
    else if (this.ctx instanceof TorrentFurrowContext)
      this.ctx.peer_ctx.publish({
        type: "ACK",
        message_id: this.properties.message_id!,
        seeder: {
          id: this.ctx.seeder_ctx.identifier,
          name: this.ctx.seeder_ctx.name,
        },
        furrow: { id: this.ctx.identifier, name: this.ctx.name },
      });
  }
}
