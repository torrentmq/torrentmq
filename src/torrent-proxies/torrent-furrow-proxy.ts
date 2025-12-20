import { TorrentFurrow } from "../torrent-furrow";
import { TorrentPeer } from "../torrent-peer";
import {
  TorrentCallBack,
  TorrentConsumeParams,
  TorrentFurrowHostedObj,
  TorrentFurrowParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentSeederHostedObj,
} from "../torrent-types";
import { TorrentUtils } from "../torrent-utils";
import { TorrentSeederProxy } from "./torrent-seeder-proxy";

export class TorrentFurrowProxy {
  private readonly peer: TorrentPeer;
  private binding_key: string | null = null;

  private seeder: TorrentSeederProxy;
  private furrow: TorrentFurrow | null = null;
  private utils: TorrentUtils = new TorrentUtils();
  private is_planted: boolean = false;
  private is_bound: boolean = false;
  options: TorrentFurrowParams;

  name: string;
  identifier: string = "";

  private constructor(
    peer: TorrentPeer,
    seeder: TorrentSeederProxy,
    furrow: TorrentFurrow | { identifier: string; name: string },
  ) {
    this.peer = peer;
    this.seeder = seeder;
    this.furrow = furrow instanceof TorrentFurrow ? furrow : null;
    this.identifier = furrow.identifier ?? TorrentUtils.random_string();
    this.name = furrow.name ?? TorrentUtils.random_string();
    this.options = furrow instanceof TorrentFurrow ? furrow.options : {};

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

    this.peer.on<{
      seeder: TorrentSeederHostedObj & { public_key: JsonWebKey };
      furrow?: TorrentFurrowHostedObj;
      peer_id: string;
    }>("FOUND", (data) => {
      if (
        data.furrow &&
        data.seeder.id === this.seeder.identifier && // checks if the seeder id is right
        this.name === data.furrow?.furrow_name // check if the furrow name is the same
      )
        this._set_host({
          identifier: data.furrow.id,
          name: data.furrow.furrow_name,
        });
    });
  }

  static create(
    peer: TorrentPeer,
    seeder: TorrentSeederProxy,
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ): TorrentFurrowProxy {
    let name: string | undefined;

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
    }
    let furrow: TorrentFurrow | undefined;
    if (seeder instanceof TorrentSeederProxy && seeder.seeder)
      furrow = TorrentFurrow.create(peer, seeder.seeder, arg1, arg2);

    const furrow_proxy = new TorrentFurrowProxy(
      peer,
      seeder,
      furrow ?? {
        identifier: TorrentUtils.random_string(),
        name: name ?? TorrentUtils.random_string(),
      },
    );
    return furrow_proxy;
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

  private async _set_host(
    furrow: TorrentFurrow | { identifier: string; name: string },
  ) {
    if (furrow instanceof TorrentFurrow) {
      this.furrow = furrow;
      this.seeder = await TorrentSeederProxy.create(this.peer);
      this.seeder._set_host(furrow.seeder);
      this.options = furrow.options;
    } else {
      this.furrow = null;
      this.options = {};
    }

    if (this.is_bound) this.bind(this.binding_key ?? undefined);

    this.name = furrow.name;
    this.identifier = furrow.identifier;
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
    if (this.furrow) this.furrow?.unplant;
    this.is_planted = false;
  }

  bind(routing_key?: string) {
    this.is_bound = true;
    if (routing_key) this.binding_key = routing_key;
    if (this.furrow) this.furrow.bind(routing_key);
    else
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
    this.is_bound = false;
    if (routing_key) this.binding_key = routing_key;
    if (this.furrow) this.unbind(routing_key);
    else
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
}
