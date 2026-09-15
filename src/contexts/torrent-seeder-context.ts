import { TorrentUtils } from "../torrent-utils";
import type {
  TorrentSeederFurrowMode,
  TorrentControlMessage,
  TorrentSignalMessage,
  TorrentSeederParams,
} from "../torrent-types";
import type { TorrentPeerContext } from "./torrent-peer-context";
import { TorrentError } from "../torrent-error";
import { TorrentIdentity } from "../torrent-identity";
import { TorrentEphemeral } from "../torrent-ephemeral";

export class TorrentSeederContext {
  protected _identity!: TorrentIdentity;
  private _identifier!: string;
  private _public_key!: JsonWebKey;
  private _swarm_key!: ArrayBuffer;

  readonly ctx: TorrentPeerContext;

  readonly name: string;
  readonly options: TorrentSeederParams;

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
    ctx: TorrentPeerContext;
    name: string;
    options: TorrentSeederParams;
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

  private _start_intervals(): void {
    this.pulse_interval = setInterval(() => {
      this.ctx.publish({
        type: "PULSE",
        seeder: {
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
    this.ctx.store.on<TorrentControlMessage | TorrentSignalMessage>(
      "set",
      async (msg) => {
        if (!TorrentUtils.is_control_message(msg)) return;
        if (msg.seeder.name !== this.name || msg.furrow) return;
        switch (msg.type) {
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

            this.ctx.publish({
              type: "EPH_KEY_OFFER",
              to: msg.from,
              seeder: {
                id: this._identifier,
                name: this.name,
              },
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

            this.ctx.publish({
              type: "EPH_KEY_EXCHANGE",
              to: msg.from,
              seeder: msg.seeder,
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
            if (msg.to !== this.ctx.identifier || !this.eph_aes_key) return;
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

  private async _initialize(): Promise<void> {
    this._identity = await TorrentIdentity.create();
    this._identifier = await this._identity.get_identifier();
    this._public_key = (await this._identity.export_public_key()) as JsonWebKey;
    this._swarm_key = await TorrentUtils.generate_swarm_key();
  }
}
