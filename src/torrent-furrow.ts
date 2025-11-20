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

// bind is seeder to furrow (seeder is parent)
// subscribe is furrow to client

export class TorrentFurrow {
  private peers: Map<string, { routing_key: string; is_bound: boolean }> =
    new Map();
  private peer: TorrentPeer;
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
    this.peer = rtc_client;
    if (options?.exclusive && this.peers.size < 1)
      this.peers.set(rtc_client.identifier, {
        routing_key: rtc_client.identifier,
        is_bound: false,
      });

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

    if (!this.peers) throw new TorrentError("Seeder requires a peer to send");
    if (this.peers.size === 0)
      throw new TorrentError("Cannot send: no peers connected");
    this.seeder.send(body, params, this);
  }

  bind(routing_key?: string) {
    this.peers.set(this.peer.identifier, {
      routing_key: routing_key ? routing_key : this.peer.identifier,
      is_bound: true,
    });
  }

  unbind() {
    const data = this.peers.get(this.peer.identifier);
    if (!data) return;

    this.peers.set(this.peer.identifier, {
      ...data,
      is_bound: false,
    });
  }
}
