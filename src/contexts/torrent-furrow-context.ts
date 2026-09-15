import { TorrentUtils } from "../torrent-utils";
import type {
  TorrentSeederFurrowMode,
  TorrentControlMessage,
  TorrentSignalMessage,
  TorrentFurrowParams,
  TorrentCallback,
  TorrentMessageBody,
} from "../torrent-types";
import type { TorrentPeerContext } from "./torrent-peer-context";
import type { TorrentSeederContext } from "./torrent-seeder-context";
import { TorrentError } from "../torrent-error";
import { TorrentIdentity } from "../torrent-identity";
import { TorrentEphemeral } from "../torrent-ephemeral";
import { TorrentMessage } from "../torrent-message";

export class TorrentFurrowContext {
  protected _identity!: TorrentIdentity;
  private _identifier!: string;
  private _public_key!: JsonWebKey;
  private _swarm_key!: ArrayBuffer;

  protected ctx: TorrentSeederContext;

  readonly name: string;
  options: TorrentFurrowParams;

  private _routing_keys: Set<string> = new Set<string>();
  private _plant_callbacks: Set<TorrentCallback> = new Set<TorrentCallback>();

  private mode: TorrentSeederFurrowMode = "ROOT";

  private eph_aes_key?: TorrentEphemeral;
  private eph_key_exchange?: Promise<TorrentEphemeral>;

  private current_term: number = 1;
  readonly created_at: number = Date.now();
  private pulse_interval: ReturnType<typeof setInterval> | null = null;

  constructor({
    ctx,
    name,
    options,
  }: {
    ctx: TorrentSeederContext;
    name: string;
    options: TorrentFurrowParams;
  }) {
    this.ctx = ctx;
    this.name = name;
    this.options = options;

    this._initialize().then();
    this._attach_handlers();
    this._start_intervals();
  }

  get identifier(): string {
    return this._identifier;
  }

  get identity(): TorrentIdentity {
    return this._identity;
  }

  get public_key(): JsonWebKey {
    return this._public_key;
  }

  get swarm_key(): ArrayBuffer {
    return this._swarm_key;
  }

  get peer_ctx(): TorrentPeerContext {
    return this.ctx.ctx;
  }

  get plant_callbacks(): Set<TorrentCallback> {
    return this._plant_callbacks;
  }

  get routing_keys(): Set<string> {
    return this._routing_keys;
  }

  private _start_intervals(): void {
    this.pulse_interval = setInterval(() => {
      this.peer_ctx.publish({
        type: "PULSE",
        seeder: {
          id: this.ctx.identifier,
          name: this.ctx.name,
        },
        furrow: {
          id: this._identifier,
          name: this.name,
        },
        term: this.current_term,
        created_at: this.created_at,
        options: this.options,
      });
    }, 5000);
  }

  private _attach_handlers(): void {
    this.peer_ctx.store.on<TorrentControlMessage | TorrentSignalMessage>(
      "set",
      async (msg) => {
        if (!TorrentUtils.is_control_message(msg)) return;
        if (msg.seeder.name !== this.ctx.name) return;
        if (msg.type !== "PUBLISH") {
          if (!msg.furrow || msg.furrow.name !== this.name) return;
        } else {
          if (msg.furrow && msg.furrow.name !== this.name) return;
        }

        switch (msg.type) {
          case "PUBLISH": {
            const valid_sig = await TorrentUtils.verify_with_key(
              TorrentUtils.to_array_buffer(msg.message.body),
              TorrentUtils.base64_to_buffer(msg.message.artifacts.signature),
              msg.message.artifacts.public_key,
            );

            if (!valid_sig) return;

            const swarm_key = msg.furrow ? this._swarm_key : this.ctx.swarm_key;
            let decrypted_msg: ArrayBuffer | undefined;

            const valid_mac = await TorrentUtils.verify_mac(
              TorrentUtils.base64_to_buffer(msg.message.body as string),
              swarm_key,
              msg.message.artifacts.mac,
            );

            if (valid_mac) {
              decrypted_msg =
                (await TorrentUtils.decrypt(
                  TorrentUtils.base64_to_buffer(msg.message.body as string),
                  swarm_key,
                )) ?? undefined;
            }

            if (!decrypted_msg) return;
            const message_body = TorrentUtils.from_array_buffer(decrypted_msg);
            const message = new TorrentMessage(
              message_body as TorrentMessageBody,
            );

            // handle different seeder types
            const routing_key = msg.message.properties?.routing_key;
            switch (this.ctx.options.type) {
              case "fanout":
                // every callback receives every message.
                break;

              // message must match at least one queue binding.
              case "direct": {
                if (!routing_key || !this.routing_keys.has(routing_key)) return;
                break;
              }
              case "topic": {
                if (!routing_key) return;
                const matched = [...this.routing_keys].some((binding) =>
                  this._topic_matches(binding, routing_key),
                );

                if (!matched) return;
                break;
              }
            }

            for (const callback of this._plant_callbacks) {
              callback(message);
            }

            break;
          }

          case "PULSE": {
            if (msg.term < this.current_term || this.eph_key_exchange) return;

            const should_exchange =
              msg.term > this.current_term ||
              (msg.term === this.current_term &&
                msg.created_at < this.created_at);

            if (!should_exchange) return;
            // send message to init swarm key exchange
            this.current_term = msg.term;
            this.eph_key_exchange = TorrentEphemeral.create();
            const eph_key = await this.eph_key_exchange;
            this.eph_aes_key = eph_key;

            const eph_public_key_array_buffer: ArrayBuffer =
              (await this.eph_aes_key.export_public_key("raw")) as ArrayBuffer;

            this.peer_ctx.publish({
              type: "EPH_KEY_OFFER",
              to: msg.from,
              seeder: {
                id: this.ctx.identifier,
                name: this.ctx.name,
              },
              furrow: { id: this._identifier, name: this.name },
              eph_public_key: TorrentUtils.buffer_to_base64(
                eph_public_key_array_buffer,
              ),
            });
            break;
          }

          case "EPH_KEY_OFFER": {
            if (this.mode !== "ROOT" || this.eph_aes_key) return;
            const eph_key = await TorrentEphemeral.create();

            const signature = await this._identity.sign(
              TorrentUtils.base64_to_buffer(msg.eph_public_key),
            );
            const eph_public_key_array_buffer: ArrayBuffer =
              (await eph_key.export_public_key("raw")) as ArrayBuffer;
            this.eph_aes_key = eph_key;
            const aes_salt = TorrentUtils.generate_salt();

            const aes_key = await TorrentUtils.create_aes_key(
              (await eph_key.export_private_key("crypto")) as CryptoKey,
              TorrentUtils.base64_to_buffer(msg.eph_public_key),
              aes_salt,
            );
            const encrypted_swarm_key_array_buffer = await TorrentUtils.encrypt(
              this._swarm_key,
              aes_key,
            );

            this.peer_ctx.publish({
              type: "EPH_KEY_EXCHANGE",
              to: msg.from,
              seeder: msg.seeder,
              furrow: msg.furrow,
              eph_public_key: TorrentUtils.buffer_to_base64(
                eph_public_key_array_buffer,
              ),
              key_sig: {
                eph_public_key: msg.eph_public_key,
                signature: TorrentUtils.buffer_to_base64(signature),
                identity_public_key: this._public_key,
              },
              encrypted: {
                swarm_key: TorrentUtils.buffer_to_base64(
                  encrypted_swarm_key_array_buffer,
                ),
                aes_salt: TorrentUtils.buffer_to_base64(aes_salt),
              },
            });

            break;
          }

          case "EPH_KEY_EXCHANGE": {
            if (msg.to !== this.peer_ctx.identifier || !this.eph_aes_key)
              return;
            const valid = await TorrentUtils.verify_with_key(
              (await this.eph_aes_key.export_public_key("raw")) as ArrayBuffer,
              TorrentUtils.base64_to_buffer(msg.key_sig.signature),
              msg.key_sig.identity_public_key,
            );

            if (!valid)
              throw new TorrentError(
                "Failed to verify the signature of the ephemeral public key",
              );

            const aes_salt = TorrentUtils.base64_to_buffer(
              msg.encrypted.aes_salt,
            );

            const aes_key = await TorrentUtils.create_aes_key(
              (await this.eph_aes_key.export_private_key(
                "crypto",
              )) as CryptoKey,
              TorrentUtils.base64_to_buffer(msg.eph_public_key),
              aes_salt,
            );
            const encrypted_swarm_key = TorrentUtils.base64_to_buffer(
              msg.encrypted.swarm_key,
            );
            const swarm_key = await TorrentUtils.decrypt(
              encrypted_swarm_key,
              aes_key,
            );

            if (!swarm_key) return;
            this._swarm_key = swarm_key;
            this.mode = "SHADOW"; // ensure to change mode to shadoow
            this.eph_aes_key = undefined; // ensure to unset
            this.eph_key_exchange = undefined;
            if (this.pulse_interval) clearInterval(this.pulse_interval);
            this.pulse_interval = null;

            break;
          }
        }
      },
    );
  }

  private _topic_matches(binding: string, routing_key: string): boolean {
    const binding_parts = binding.split(".");
    const routing_parts = routing_key.split(".");

    let i = 0;
    let j = 0;

    while (i < binding_parts.length) {
      const binding_part = binding_parts[i];

      if (binding_part === "#") {
        // # matches zero or more words.
        return true;
      }

      if (j >= routing_parts.length) {
        return false;
      }

      if (binding_part !== "*" && binding_part !== routing_parts[j]) {
        return false;
      }

      i++;
      j++;
    }

    return j === routing_parts.length;
  }

  private async _initialize(): Promise<void> {
    this._identity = await TorrentIdentity.create();
    this._identifier = await this._identity.get_identifier();
    this._public_key = (await this._identity.export_public_key()) as JsonWebKey;
    this._swarm_key = await TorrentUtils.generate_swarm_key();
    // set routing keys if passed in
    this._routing_keys = new Set(this.options.routing_keys);
  }
}
