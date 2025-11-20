import { TorrentError } from "./torrent-error";
import { TorrentFurrow } from "./torrent-furrow";
import { TorrentMessage } from "./torrent-message";
import { TorrentPeer } from "./torrent-peer";
import {
  TorrentFurrowParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentSeederParams,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentSeeder {
  private peer: TorrentPeer;
  private furrows: TorrentFurrow[] = [];
  private utils: TorrentUtils = new TorrentUtils();

  readonly identifier = this.utils.random_string();
  readonly name: string;
  readonly options: TorrentSeederParams = {};

  constructor(
    arg1?: string | TorrentPeer | TorrentSeederParams,
    arg2?: string | TorrentPeer | TorrentSeederParams,
    arg3?: string | TorrentPeer | TorrentSeederParams,
  ) {
    let name: string | undefined;
    let options: TorrentSeederParams | undefined;
    let rtc_client: TorrentPeer | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (typeof arg === "string") name = arg;
      else if (this.utils.is_peer(arg)) rtc_client = arg;
      else if (this.utils.is_seeder_params(arg)) options = arg;
    }

    if (!rtc_client) throw new TorrentError("This seeder requires a peer");

    this.name = name ?? this.utils.random_string();
    this.options = options ?? {};
    this.peer = rtc_client;

    this.peer.register_remote_binding({ id: this.identifier, name: this.name });

    return this;
  }

  send(
    arg1?: TorrentMessageBody | TorrentMessageParams | TorrentFurrow,
    arg2?: TorrentMessageBody | TorrentMessageParams | TorrentFurrow,
    arg3?: TorrentMessageBody | TorrentMessageParams | TorrentFurrow,
  ) {
    let body: TorrentMessageBody | undefined;
    let params: TorrentMessageParams | undefined;
    let furrow: TorrentFurrow | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (this.utils.is_message_params(arg)) params = arg;
      else if (this.utils.is_furrow(arg)) furrow = arg;
      else if (arg !== undefined) body = arg;
    }

    if (!this.peer) throw new Error("Seeder requires a peer to send");
    this.peer.publish({
      message: new TorrentMessage(body || null, params),
      seeder: {
        id: this.identifier,
        name: this.name,
      },
      ...(furrow
        ? {
            furrow: {
              id: furrow.identifier,
              name: furrow.name,
            },
          }
        : {}),
    });
  }

  furrow(
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ) {
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;

    if (typeof arg1 === "string") {
      name = arg1;
      if (arg2 && typeof arg2 === "object") options = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      options = arg1;
      if (typeof arg2 === "string") name = arg2;
    }

    const furrow = new TorrentFurrow(name, options, this, this.peer);
    this.furrows.push(furrow);
    return furrow;
  }
}
