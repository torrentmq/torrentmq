import { TorrentEmitter } from "./torrent-emitter";
import { TorrentFurrow } from "./torrent-furrow";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";
import { TorrentPeer } from "./torrent-peer";
import { TorrentFurrowProxy } from "./torrent-proxies/torrent-furrow-proxy";
import {
  TorrentFurrowParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentSeederParams,
  TorrentFurrowHostedObj,
  TorrentSeederHostedObj,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentSeeder extends TorrentEmitter<"CREATED_FURROW"> {
  furrows: TorrentFurrow[] = [];
  private utils: TorrentUtils = new TorrentUtils();

  private readonly peer: TorrentPeer;
  readonly identity: TorrentIdentity;
  readonly identifier: string;
  readonly public_key: JsonWebKey;
  readonly name: string;
  readonly options: TorrentSeederParams;

  private constructor(
    identity: TorrentIdentity,
    identifier: string,
    peer: TorrentPeer,
    public_key: JsonWebKey,
    name?: string,
    options?: TorrentSeederParams,
  ) {
    super();

    this.identity = identity;
    this.identifier = identifier;
    this.peer = peer;
    this.public_key = public_key;
    this.name = name ?? TorrentUtils.random_string();
    this.options = options ?? {};
  }

  static async create(
    peer: TorrentPeer,
    arg1?: string | TorrentSeederParams | TorrentIdentity,
    arg2?: string | TorrentSeederParams | TorrentIdentity,
    arg3?: string | TorrentSeederParams | TorrentIdentity,
  ): Promise<TorrentSeeder> {
    let name: string | undefined;
    let options: TorrentSeederParams | undefined;
    let identity: TorrentIdentity | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (typeof arg === "string") name = arg;
      else if (arg instanceof TorrentIdentity) identity = arg;
      else if (arg) options = arg;
    }

    // generate identity if none supplied
    identity ??= await TorrentIdentity.create();
    const identifier = await identity.get_identifier();
    const seeder = new TorrentSeeder(
      identity,
      identifier,
      peer,
      await identity.export_public_jwk(),
      name,
      options,
    );

    return seeder;
  }

  async send(
    arg1?:
      | TorrentMessageBody
      | TorrentMessageParams
      | TorrentFurrow
      | TorrentFurrowProxy,
    arg2?:
      | TorrentMessageBody
      | TorrentMessageParams
      | TorrentFurrow
      | TorrentFurrowProxy,
    arg3?:
      | TorrentMessageBody
      | TorrentMessageParams
      | TorrentFurrow
      | TorrentFurrowProxy,
  ) {
    let body: TorrentMessageBody | undefined;
    let params: TorrentMessageParams | undefined;
    let furrow: TorrentFurrow | TorrentFurrowProxy | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (this.utils.is_message_params(arg)) params = arg;
      else if (
        arg instanceof TorrentFurrow ||
        arg instanceof TorrentFurrowProxy
      )
        furrow = arg;
      else if (arg !== undefined) body = arg;
    }

    const message = new TorrentMessage(body || null, params);
    const msg_bytes = await this.identity.sign(
      TorrentUtils.to_array_buffer(message.body),
    );
    const signature = await this.identity.sign(msg_bytes);

    this.peer.publish({
      seeder: {
        id: this.identifier,
        name: this.name,
        public_key: this.public_key,
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
      signature: TorrentUtils.to_base64_url(signature),
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

    const furrow = TorrentFurrow.create(this.peer, this, options, name);
    this.furrows.push(furrow);

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
        id: furrow.identifier,
        furrow_name: furrow.name,
        ...(furrow.options && Object.keys(furrow.options).length > 0
          ? { properties: { ...furrow.options } }
          : {}),
      },
    });

    return furrow;
  }
}
