import { TorrentError } from "./torrent-error";
import { TorrentPeer } from "./torrent-peer";
import { TorrentSeeder } from "./torrent-seeder";
import {
  TorrentCallBack,
  TorrentConsumeParams,
  TorrentFurrowParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentSeederParams,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentFurrow {
  private peers: Map<string, { routing_key: string; is_bound: boolean }> =
    new Map();
  private utils: TorrentUtils = new TorrentUtils();
  private is_planted: boolean = false;

  private readonly peer: TorrentPeer;
  private readonly seeder: TorrentSeeder;

  readonly identifier: string;
  readonly name: string;
  readonly options: TorrentFurrowParams;

  private constructor(
    identifier: string,
    peer: TorrentPeer,
    seeder: TorrentSeeder,
    name?: string,
    options?: TorrentSeederParams,
  ) {
    this.identifier = identifier;
    this.peer = peer;
    this.seeder = seeder;
    this.name = name ?? TorrentUtils.random_string();
    this.options = options ?? {};

    this.peer.find(
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

  static create(
    peer: TorrentPeer,
    seeder: TorrentSeeder,
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ): TorrentFurrow {
    let name: string | undefined;
    let options: TorrentSeederParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = arg;
    }

    const identifier = TorrentUtils.random_string();
    const furrow = new TorrentFurrow(identifier, peer, seeder, name, options);

    return furrow;
  }

  async send(
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
    if (this.peers.size === 0) throw new TorrentError("No peers connected");
    await this.seeder.send(body, params, this);
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
    if (callback) this.peer.on("MESSAGE_RECEIVE", callback);
  }

  unplant() {
    this.is_planted = false;
  }

  async bind(routing_key?: string) {
    this.peers.set(this.peer.identifier, {
      routing_key: routing_key ? routing_key : this.peer.identifier,
      is_bound: true,
    });

    this.peer.register_remote_binding(
      {
        id: this.seeder.identifier,
        name: this.seeder.name,
        public_key: this.seeder.public_key,
      },
      {
        id: this.identifier,
        name: this.name,
        routing_key,
      },
    );
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
