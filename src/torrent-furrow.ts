import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";
import { TorrentSeeder } from "./torrent-seeder";
import {
  TorrentCallBack,
  TorrentConsumeParams,
  TorrentControlMessage,
  TorrentFurrowParams,
  TorrentHostedObj,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentSeederFurrowSecurityObject,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentFurrow {
  identifier: string;
  is_root: boolean = true;
  is_planted: boolean | "unset" = "unset";
  pub_key: JsonWebKey;
  protected readonly seeder: TorrentSeeder;
  protected swarm_key: ArrayBuffer;
  identity: TorrentIdentity;

  readonly name: string;
  readonly options: TorrentFurrowParams;

  private constructor(
    seeder: TorrentSeeder,
    arg1?: string | TorrentFurrowParams | TorrentSeederFurrowSecurityObject,
    arg2?: string | TorrentFurrowParams | TorrentSeederFurrowSecurityObject,
    arg3?: string | TorrentFurrowParams | TorrentSeederFurrowSecurityObject,
  ) {
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;
    let security: TorrentSeederFurrowSecurityObject | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (typeof arg === "string") name = arg;
      else if (TorrentUtils.is_security_object(arg)) security = arg;
      else if (arg) options = arg;
    }

    this.seeder = seeder;
    this.name = name ?? TorrentUtils.random_string();
    this.options = options ?? {};

    if (security) {
      const { identity, identifier, pub_key, swarm_key } = security;

      this.identity = identity;
      this.identifier = identifier;
      this.pub_key = pub_key;
      this.swarm_key = swarm_key;
    }

    this.seeder.peer.on<{
      seeder: TorrentHostedObj & { swarm_key: ArrayBuffer };
      furrow?: TorrentHostedObj & { swarm_key: ArrayBuffer };
      peer_id: string;
    }>("swarm_key_exchanged", (data) => {
      if (!data.furrow) return;
      if (
        data.seeder.name !== this.seeder.name &&
        data.seeder.id! === this.seeder.identifier
      )
        return;
      if (this.name !== data.furrow.name) return;

      this.identifier = data.furrow.id;
      this.swarm_key = data.furrow.swarm_key;
      this.is_root = false;
    });
  }

  static async create(
    seeder: TorrentSeeder,
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ) {
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = arg;
    }

    name = name ?? TorrentUtils.random_string();

    const identity: TorrentIdentity = await TorrentIdentity.create();
    const identifier: string = await identity.get_identifier();
    const pub_key: JsonWebKey = await identity.export_public_jwk();
    const swarm_key: ArrayBuffer = await TorrentUtils._generate_swarm_key();
    const security_obj: TorrentSeederFurrowSecurityObject = {
      identifier,
      identity,
      pub_key,
      swarm_key,
    };

    const furrow = new TorrentFurrow(seeder, name, options, security_obj);

    seeder.peer.find(
      {
        id: seeder.identifier,
        name: seeder.name,
      },
      {
        id: identifier,
        name,
      },
    );

    return furrow;
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
            id: this.seeder.identifier,
            name: this.seeder.name,
          },
          furrow: {
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
            this.seeder.peer.publish({
              ...send_message,
              seeder: {
                ...send_message.seeder,
                pub_key: this.seeder.pub_key,
              },
              furrow: {
                ...send_message.furrow,
                pub_key: this.pub_key,
              },
              artifacts: {
                ...send_message.artifacts,
                pub_key: this.pub_key,
                signature: TorrentUtils.to_base64_url(signature),
              },
            });
          });
        else this.seeder.peer.submit(send_message);
      });
    });
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

    if (this.is_planted !== "unset") this.is_planted = true;
    if (callback)
      this.seeder.peer.on<Extract<TorrentControlMessage, { type: "PUBLISH" }>>(
        "message_receive",
        (msg) => {
          if (msg.seeder.id !== this.seeder.identifier) return;
          if (msg.furrow && msg.furrow.id !== this.identifier) return;

          const swarm_key = msg.furrow ? this.swarm_key : this.seeder.swarm_key;

          TorrentIdentity.verify(
            TorrentUtils.to_array_buffer(msg.message.body),
            TorrentUtils.from_base64_url(msg.message.artifacts.signature),
            msg.message.artifacts.pub_key,
          ).then((valid) => {
            if (!valid) return;

            TorrentUtils.verify_mac(
              TorrentUtils.from_base64_url(msg.message.body as string),
              swarm_key,
              msg.message.artifacts.mac,
            ).then((valid) => {
              if (!valid) return;

              TorrentUtils.decrypt(
                TorrentUtils.from_base64_url(msg.message.body as string),
                swarm_key,
              ).then((decrypted_msg) => {
                if (!decrypted_msg) return;
                const message_body =
                  TorrentUtils.from_array_buffer(decrypted_msg);
                const message = new TorrentMessage(
                  message_body as TorrentMessageBody,
                  msg.message.properties,
                );

                if (this.is_planted) callback?.(message);
              });
            });
          });
        },
      );
  }

  unplant() {
    this.is_planted = false;
  }

  bind(routing_key?: string) {
    this.seeder.peer.register_remote_binding(
      {
        id: this.seeder.identifier,
        name: this.seeder.name,
        pub_key: this.seeder.pub_key,
      },
      {
        id: this.identifier,
        name: this.name,
        routing_key,
      },
    );
  }

  unbind(routing_key?: string) {
    this.seeder.peer.unregister_remote_binding(
      {
        id: this.seeder.identifier,
        name: this.seeder.name,
        pub_key: this.seeder.pub_key,
      },
      {
        id: this.identifier,
        name: this.name,
        routing_key,
      },
    );
  }

  get_swarm_key() {
    return this.swarm_key;
  }
}
