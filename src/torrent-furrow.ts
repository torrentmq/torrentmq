import { TorrentError } from "./torrent-error";
import { TorrentPeer } from "./torrent-peer";
import { TorrentSeeder } from "./torrent-seeder";
import {
  TorrentCallBack,
  TorrentConsumeParams,
  TorrentFurrowParams,
  TorrentMessageBody,
  TorrentMessageParams,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentFurrow {
  private peers: TorrentPeer[] = [];
  private is_bound: boolean = false;
  private is_planted: boolean = false;
  private utils: TorrentUtils = new TorrentUtils();

  readonly identifier: string = this.utils.random_string();
  readonly name: string;
  readonly options: TorrentFurrowParams = {};
  readonly seeder: TorrentSeeder;

  constructor(
    arg1?: string | TorrentFurrowParams | TorrentSeeder | TorrentPeer,
    arg2?: string | TorrentFurrowParams | TorrentSeeder | TorrentPeer,
    arg3?: string | TorrentFurrowParams | TorrentSeeder | TorrentPeer,
    arg4?: string | TorrentFurrowParams | TorrentSeeder | TorrentPeer,
  ) {
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;
    let seeder: TorrentSeeder | undefined;
    let rtc_client: TorrentPeer | undefined;

    for (const arg of [arg1, arg2, arg3, arg4]) {
      if (typeof arg === "string") name = arg;
      else if (this.utils.is_peer(arg)) rtc_client = arg;
      else if (this.utils.is_furrow_params(arg)) options = arg;
      else if (this.utils.is_seeder(arg)) seeder = arg;
    }

    if (!seeder) throw new TorrentError("This furrow requires a seeder");
    if (!rtc_client) throw new TorrentError("This furrow requires a peer");

    this.name = name ?? this.utils.random_string();
    this.options = options ?? {};
    this.seeder = seeder;
    this.peers.push(rtc_client);

    if (options?.auto_plant) this.plant();
    if (options?.auto_bind) this.bind();

    return this;
  }

  plant(
    arg1?: TorrentCallBack | TorrentConsumeParams,
    arg2?: TorrentCallBack | TorrentConsumeParams,
  ) {
    let callback: TorrentCallBack | undefined;
    let params: TorrentConsumeParams | undefined;

    if (typeof arg1 === "function") {
      callback = arg1;
      if (arg2 && typeof arg2 === "object") params = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      params = arg1;
      if (typeof arg2 === "function") callback = arg2;
    }

    if (!this.is_planted) this.is_planted = true;
  }

  unplant() {
    this.is_planted = false;
  }

  send(
    arg1?: TorrentMessageBody | TorrentMessageParams,
    arg2?: TorrentMessageBody | TorrentMessageParams,
  ) {
    let body: TorrentMessageBody | undefined;
    let params: TorrentMessageParams | undefined;

    if (this.utils.is_message_params(arg1)) {
      params = arg1;
      if (arg2 !== undefined) body = arg2;
    } else {
      body = arg1;
      if (this.utils.is_message_params(arg2)) params = arg2;
    }

    if (!this.peers) throw new Error("Seeder requires a peer to send");
    this.seeder.send(body, params, this);
  }

  bind() {
    for (const p of this.peers) {
      this.bind_to_peer(p);
    }
    this.is_bound = true;
  }

  private bind_to_peer(peer: TorrentPeer) {
    if (!this.peers.includes(peer)) this.peers.push(peer);
    peer.register_remote_binding(
      {
        id: this.seeder.identifier,
        name: this.seeder.name,
      },
      {
        id: this.identifier,
        name: this.name,
      },
    );
  }

  unbind() {
    for (const p of this.peers) {
      if (!this.peers.includes(p)) this.peers.push(p);
      p.register_remote_binding(
        {
          id: this.seeder.identifier,
          name: this.seeder.name,
        },
        {
          id: this.identifier,
          name: this.name,
        },
      );
    }

    this.is_bound = false;
  }
}
