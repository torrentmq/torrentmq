import { TorrentUtils } from "./torrent-utils";
import {
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentControlMessage,
  TorrentSignalMessage,
  TorrentFurrowParams,
  TorrentCallback,
  TorrentConsumeParams,
  TorrentSubscription,
} from "./torrent-types";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentContext } from "./torrent-context";
import { TorrentMessage } from "./torrent-message";

export class TorrentFurrow {
  protected identity!: TorrentIdentity;
  private _identifier!: string;
  private public_key!: JsonWebKey;
  private swarm_key!: ArrayBuffer;

  protected ctx: TorrentContext;
  protected seeder: { name: string; swarm_key: ArrayBuffer };

  readonly name: string;
  protected _options: TorrentFurrowParams;
  private routing_keys: Set<string> = new Set<string>();
  private plant_callbacks: Set<TorrentCallback> = new Set<TorrentCallback>();

  constructor(
    ctx: TorrentContext,
    seeder: { name: string; swarm_key: ArrayBuffer },
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ) {
    this.ctx = ctx;
    this.seeder = seeder;

    let name: string = TorrentUtils.random_string();
    let options: TorrentFurrowParams = {
      passive: false,
      durable: false,
      auto_delete: true,
      // key_refresh: 60000,
      routing_keys: undefined,
      args: undefined,
      exclusive: false,
    };

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = { ...options, ...arg };
    }

    this.name = name;
    this._options = options;

    this._initialize().then();
    this._attach_handlers();
  }

  get identifier(): string {
    return this._identifier;
  }

  get options(): TorrentFurrowParams {
    return this._options;
  }

  async send(
    arg1?: TorrentMessageBody | TorrentMessageParams,
    arg2?: TorrentMessageBody | TorrentMessageParams,
  ): Promise<void> {
    let body: TorrentMessageBody | null = null;
    let params: TorrentMessageParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (TorrentUtils.is_message_params(arg)) params = arg;
      else if (arg !== undefined) body = arg;
    }

    const message = new TorrentMessage(body, {
      ...params,
      source: this.ctx.identifier,
    });
    const message_body = TorrentUtils.to_array_buffer(message.body);
    const encrypted = await TorrentUtils.encrypt(message_body, this.swarm_key);
    const mac = await TorrentUtils.generate_mac(encrypted, this.swarm_key);
    const encrypted_message = new TorrentMessage(
      TorrentUtils.buffer_to_base64(encrypted),
    );
    const encrypted_message_body = TorrentUtils.to_array_buffer(
      encrypted_message.body,
    );

    //should change to submit instead of publish
    //or insttead in the ctx publish method handle it
    const signature = await this.identity.sign(encrypted_message_body);
    this.ctx.publish({
      type: "PUBLISH",
      from: this.ctx.identifier,
      seeder: {
        id: this.identifier,
        name: this.name,
        public_key: this.public_key,
      },
      message: {
        body: encrypted_message.body,
        properties: message?.properties,
        artifacts: {
          timestamp: Date.now(),
          mac,
          public_key: this.public_key,
          signature: TorrentUtils.buffer_to_base64(signature),
        },
      },
    } as Omit<
      Extract<TorrentControlMessage, { type: "PUBLISH" }>,
      "artifacts" | "control_id"
    >);
  }

  bind(routing_key: string): void {
    this.routing_keys.add(routing_key);
    this._update_routing_keys();
  }

  unbind(routing_key: string): void {
    this.routing_keys.delete(routing_key);
    this._update_routing_keys();
  }

  // overloads to require callback is passed in
  plant(
    callback: TorrentCallback,
    params?: TorrentConsumeParams,
  ): TorrentSubscription;
  plant(
    params: TorrentConsumeParams,
    callback: TorrentCallback,
  ): TorrentSubscription;
  plant(
    arg1: TorrentCallback | TorrentConsumeParams,
    arg2?: TorrentCallback | TorrentConsumeParams,
  ) {
    let callback: TorrentCallback | undefined;
    let params: TorrentConsumeParams = {
      tag: undefined,
      exclusive: false,
      no_ack: true,
    };

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "function") callback = arg;
      else if (arg && typeof arg === "object") params = { ...params, ...arg };
    }

    if (!callback) return;
    this.plant_callbacks.add(callback);
    return {
      unplant: () => {
        this.plant_callbacks.delete(callback);
      },
    };
  }

  private _update_routing_keys(): void {
    this._options = {
      ...this._options,
      routing_keys: Array.from(this.routing_keys),
    };
  }

  private _attach_handlers(): void {
    this.ctx.store.on<TorrentControlMessage | TorrentSignalMessage>(
      "set",
      async (msg) => {
        if (!TorrentUtils.is_control_message(msg)) return;
        if (msg.type === "PUBLISH") {
          if (msg.seeder.name !== this.seeder.name) return;
          if (msg.furrow && msg.furrow.name !== this.name) return;

          const valid_sig = await TorrentUtils.verify_with_key(
            TorrentUtils.to_array_buffer(msg.message.body),
            TorrentUtils.base64_to_buffer(msg.message.artifacts.signature),
            msg.message.artifacts.public_key,
          );

          if (!valid_sig) return;

          const swarm_key = msg.furrow ? this.swarm_key : this.seeder.swarm_key;
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
          for (const callback of this.plant_callbacks) {
            callback(message);
          }
        }
      },
    );
  }

  private async _initialize(): Promise<void> {
    this.identity = await TorrentIdentity.create();
    this._identifier = await this.identity.get_identifier();
    this.public_key = (await this.identity.export_public_key()) as JsonWebKey;
    this.swarm_key = await TorrentUtils.generate_swarm_key();
    // set routing keys if passed in
    this.routing_keys = new Set(this._options.routing_keys);
  }
}
