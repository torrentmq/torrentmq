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
  private utils: TorrentUtils = new TorrentUtils();
  private is_planted: boolean = false;

  private readonly peer: TorrentPeer;

  readonly seeder: TorrentSeeder;
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
  }

  static create(
    peer: TorrentPeer,
    seeder: TorrentSeeder,
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ): TorrentFurrow {
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;

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

  bind(routing_key?: string) {
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

  unbind(routing_key?: string) {
    this.peer.unregister_remote_binding(
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
}
