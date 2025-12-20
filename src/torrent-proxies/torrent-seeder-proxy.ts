import { TorrentFurrow } from "../torrent-furrow";
import { TorrentPeer } from "../torrent-peer";
import { TorrentSeeder } from "../torrent-seeder";
import { TorrentUtils } from "../torrent-utils";
import {
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentSeederParams,
  TorrentSeederHostedObj,
  TorrentFurrowHostedObj,
  TorrentFurrowParams,
} from "../torrent-types";
import { TorrentMessage } from "../torrent-message";
import { TorrentIdentity } from "../torrent-identity";
import { TorrentFurrowProxy } from "./torrent-furrow-proxy";
import { TorrentEmitter } from "../torrent-emitter";

export class TorrentSeederProxy extends TorrentEmitter<"CREATED_FURROW"> {
  furrows: (TorrentFurrowProxy | TorrentFurrow)[] = [];
  private utils: TorrentUtils = new TorrentUtils();

  private readonly peer: TorrentPeer;

  private options: TorrentSeederParams;
  seeder: TorrentSeeder | null = null;
  name: string;
  identity: TorrentIdentity | null = null;
  identifier: string;
  public_key: JsonWebKey;

  private constructor(peer: TorrentPeer, seeder: TorrentSeeder) {
    super();

    this.peer = peer;
    this.seeder = seeder;
    this.identifier = seeder.identifier;
    this.public_key = seeder.public_key;
    this.name = seeder.name ?? TorrentUtils.random_string();
    this.furrows = seeder.furrows;
    this.identity = seeder.identity;
    this.options = seeder.options ?? {};

    this.peer.find({
      id: this.identifier,
      name: this.name,
    });

    this.peer.on<{
      seeder: TorrentSeederHostedObj & { public_key: JsonWebKey };
      furrow: TorrentFurrowHostedObj;
      peer_id: string;
    }>("FOUND", (data) => {
      this._set_host({
        identifier: data.seeder.id,
        name: data.seeder.seeder_name,
        public_key: data.seeder.public_key,
      });
    });

    this._furrow_init_listener();
  }

  static async create(
    peer: TorrentPeer,
    arg1?: string | TorrentSeederParams | TorrentIdentity,
    arg2?: string | TorrentSeederParams | TorrentIdentity,
    arg3?: string | TorrentSeederParams | TorrentIdentity,
  ): Promise<TorrentSeederProxy> {
    const new_seeder = await TorrentSeeder.create(peer, arg1, arg2, arg3);
    const seeder_proxy = new TorrentSeederProxy(peer, new_seeder);
    return seeder_proxy;
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

    // we want to send a request to create a furrow
    // when we get a response we can create a furrow proxy
    // add that to the list of furrow proxies
    const furrow_proxy = TorrentFurrowProxy.create(
      this.peer,
      this,
      options,
      name,
    );
    this.furrows.push(furrow_proxy);

    this.emit<{
      seeder: TorrentSeederHostedObj;
      furrow: TorrentFurrowHostedObj;
    }>("CREATED_FURROW", {
      seeder: {
        id: this.identifier,
        seeder_name: this.name,
        public_key: this.public_key,
        ...(this.options && Object.keys(this.options).length > 0
          ? { properties: { ...this.options } }
          : {}),
      },
      furrow: {
        id: furrow_proxy.identifier,
        furrow_name: furrow_proxy.name,
        ...(furrow_proxy.options && Object.keys(furrow_proxy.options).length > 0
          ? { properties: { ...furrow_proxy.options } }
          : {}),
      },
    });

    return furrow_proxy;
  }

  async send(
    arg1?: TorrentMessageBody | TorrentMessageParams | TorrentFurrowProxy,
    arg2?: TorrentMessageBody | TorrentMessageParams | TorrentFurrowProxy,
    arg3?: TorrentMessageBody | TorrentMessageParams | TorrentFurrowProxy,
  ) {
    if (this.seeder) await this.seeder.send(arg1, arg2, arg3);
    else {
      let body: TorrentMessageBody | undefined;
      let params: TorrentMessageParams | undefined;
      let furrow: TorrentFurrowProxy | undefined;

      for (const arg of [arg1, arg2, arg3]) {
        if (this.utils.is_message_params(arg)) params = arg;
        else if (arg instanceof TorrentFurrowProxy) furrow = arg;
        else if (arg !== undefined) body = arg;
      }

      const message = new TorrentMessage(body || null, params);

      this.peer.submit({
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
        message,
      });
    }
  }

  _set_host(
    seeder:
      | TorrentSeeder
      | { identifier: string; name: string; public_key: JsonWebKey },
  ) {
    if (seeder instanceof TorrentSeeder) {
      this.seeder = seeder;
      this.furrows = seeder.furrows;
      this.identity = seeder.identity;

      this._furrow_init_listener();
    } else {
      this.seeder = null;
      this.furrows = [];
      this.identity = null;
      this.options = {};
    }

    this.name = seeder.name;
    this.identifier = seeder.identifier;
    this.public_key = seeder.public_key;
  }

  private _furrow_init_listener() {
    if (this.seeder)
      this.seeder.on<{
        seeder: TorrentSeederHostedObj;
        furrow: TorrentFurrowHostedObj;
      }>("CREATED_FURROW", (data) =>
        this.emit<{
          seeder: TorrentSeederHostedObj;
          furrow: TorrentFurrowHostedObj;
        }>("CREATED_FURROW", data),
      );
  }

  static async verify_message(message: {
    seeder: {
      id: string;
      name: string;
      public_key: JsonWebKey;
    };
    payload: TorrentMessage;
    signature: string;
  }): Promise<boolean> {
    const public_key = await crypto.subtle.importKey(
      "jwk",
      message.seeder.public_key,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );

    const payload_bytes = TorrentUtils.to_array_buffer(message.payload.body);
    const signature_bytes = TorrentUtils.from_base64_url(message.signature);

    // is signature valid?
    const valid_sig = await TorrentIdentity.verify(
      payload_bytes,
      signature_bytes,
      public_key,
    );

    if (!valid_sig) return false;

    // does seeder id(entifier) match public key?
    const raw = await crypto.subtle.exportKey("raw", public_key);
    const hash = await crypto.subtle.digest("SHA-256", raw);
    const derived_id = TorrentUtils.to_base64_url(hash);

    return derived_id === message.seeder.id;
  }
}
