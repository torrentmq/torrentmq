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
        from: this.ctx.identifier,
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
    this.peer_ctx.store.on<TorrentControlMessage | TorrentSignalMessage>(
      "set",
      async (msg) => {
        if (!TorrentUtils.is_control_message(msg)) return;
        switch (msg.type) {
          case "PUBLISH": {
            if (msg.seeder.name !== this.ctx.name) return;
            if (msg.furrow && msg.furrow.name !== this.name) return;

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
            for (const callback of this._plant_callbacks) {
              callback(message);
            }

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
    // set routing keys if passed in
    this._routing_keys = new Set(this.options.routing_keys);
  }
}
