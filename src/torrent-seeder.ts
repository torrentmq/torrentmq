import { TorrentEmitter } from "./torrent-emitter";
import { TorrentFurrow } from "./torrent-furrow";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";
import { TorrentPeer } from "./torrent-peer";
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
  private furrows: TorrentFurrow[] = [];
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

    this.peer.find({
      id: this.identifier,
      name: this.name,
    });
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
    arg1?: TorrentMessageBody | TorrentMessageParams | TorrentFurrow,
    arg2?: TorrentMessageBody | TorrentMessageParams | TorrentFurrow,
    arg3?: TorrentMessageBody | TorrentMessageParams | TorrentFurrow,
  ) {
    let body: TorrentMessageBody | undefined;
    let params: TorrentMessageParams | undefined;
    let furrow: TorrentFurrow | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (this.utils.is_message_params(arg)) params = arg;
      else if (arg instanceof TorrentFurrow) furrow = arg;
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
