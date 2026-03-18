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
  TorrentHostedObj,
  TorrentSeederCertificate,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentSeeder extends TorrentEmitter<
  "initialized" | "created_furrow"
> {
  identifier: string;
  readonly peer: TorrentPeer;

  furrows: TorrentFurrow[] = [];

  pub_key: JsonWebKey;
  cert?: TorrentSeederCertificate;
  is_root: boolean = true;

  identity: TorrentIdentity;
  swarm_key: ArrayBuffer;

  readonly name: string;
  readonly options: TorrentSeederParams;

  constructor(
    peer: TorrentPeer,
    arg1?: string | TorrentSeederParams,
    arg2?: string | TorrentSeederParams,
  ) {
    super();

    let name: string | undefined;
    let options: TorrentSeederParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = arg;
    }

    this.peer = peer;
    this.name = name ?? TorrentUtils.random_string();
    this.options = options ?? {};

    // assign identity for message signing and verification
    TorrentIdentity.create().then((identity) => {
      this.identity = identity;
      identity.get_identifier().then((id) => {
        this.identifier = id;

        identity.export_public_jwk().then((jwk) => {
          this.pub_key = jwk;

          TorrentUtils._generate_swarm_key().then((key) => {
            this.swarm_key = key;

            this.peer.find({
              id,
              name: this.name,
            });

            this.emit("initialized");
          });
        });
      });
    });

    this.peer.on<{
      seeder: TorrentHostedObj & { swarm_key: ArrayBuffer };
      furrow?: TorrentHostedObj & { swarm_key: ArrayBuffer };
      peer_id: string;
    }>("swarm_key_exchanged", (data) => {
      if (data.seeder.name !== this.name) return;
      this.identifier = data.seeder.id;
      this.swarm_key = data.seeder.swarm_key;
      this.is_root = false;
    });

    return this;
  }

  send(
    arg1?: TorrentMessageBody | TorrentMessageParams,
    arg2?: TorrentMessageBody | TorrentMessageParams,
  ) {
    let body: TorrentMessageBody | undefined;
    let params: TorrentMessageParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (TorrentUtils.is_message_params(arg)) params = arg;
      else if (arg !== undefined) body = arg;
    }

    const message = new TorrentMessage(body || null, params);
    const message_body = TorrentUtils.to_array_buffer(message.body);

    // NOTE: must have been drunk when i wrote this encryption and signing logic
    // it looks like a mess, but it works, so not going to change it for now
    // being drunk would have been a good excuse but i am just sober

    // also sign with our identity if we are the root

    TorrentUtils.encrypt(message_body, this.swarm_key).then((encrypted) => {
      TorrentUtils.generate_mac(encrypted, this.swarm_key).then((mac) => {
        const encrypted_message = new TorrentMessage(
          TorrentUtils.to_base64_url(encrypted),
        );
        const encrypted_message_body = TorrentUtils.to_array_buffer(
          encrypted_message.body,
        );

        const send_message = {
          seeder: {
            id: this.identifier,
            name: this.name,
          },
          message,
          encrypted_message,
          artifacts: {
            timestamp: Date.now(),
            mac,
          },
        };

        if (this.is_root)
          this.identity.sign(encrypted_message_body).then((signature) => {
            this.peer.publish({
              ...send_message,
              seeder: {
                ...send_message.seeder,
                pub_key: this.pub_key,
              },
              artifacts: {
                ...send_message.artifacts,
                pub_key: this.pub_key,
                signature: TorrentUtils.to_base64_url(signature),
              },
            });
          });
        else this.peer.submit(send_message);
      });
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

    const furrow = new TorrentFurrow(this, options, name);
    furrow.on("initialized", () => {
      this.furrows.push(furrow);

      // emit created furrow to update hosted
      this.emit<{
        seeder: TorrentHostedObj;
        furrow: TorrentHostedObj;
      }>("created_furrow", {
        seeder: {
          id: this.identifier,
          name: this.name,
          pub_key: this.pub_key,
          ...(this.options && Object.keys(this.options).length > 0
            ? { properties: { ...this.options } }
            : {}),
        },
        furrow: {
          id: furrow.identifier,
          name: furrow.name,
          pub_key: furrow.pub_key,
          ...(furrow.options && Object.keys(furrow.options).length > 0
            ? { properties: { ...furrow.options } }
            : {}),
        },
      });
    });

    return furrow;
  }

  get_swarm_key() {
    return this.swarm_key;
  }
}
