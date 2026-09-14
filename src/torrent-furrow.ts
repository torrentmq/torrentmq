import { TorrentUtils } from "./torrent-utils";
import type {
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentFurrowParams,
  TorrentCallback,
  TorrentConsumeParams,
  TorrentSubscription,
} from "./torrent-types";
import type { TorrentPeerContext } from "./contexts/torrent-peer-context";
import type { TorrentSeederContext } from "./contexts/torrent-seeder-context";
import { TorrentFurrowContext } from "./contexts/torrent-furrow-context";
import { TorrentMessage } from "./torrent-message";

export class TorrentFurrow {
  protected seeder_ctx: TorrentSeederContext;
  protected ctx: TorrentFurrowContext;

  constructor(
    ctx: TorrentSeederContext,
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ) {
    let name: string = TorrentUtils.random_string();
    let options: TorrentFurrowParams = {
      passive: false,
      durable: false,
      auto_delete: true,
      key_refresh: 60000,

      routing_keys: undefined,

      args: undefined,
      exclusive: false,
    };

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = { ...options, ...arg };
    }

    this.seeder_ctx = ctx;
    this.ctx = new TorrentFurrowContext({ ctx, name, options });
  }

  get name(): string {
    return this.ctx.name;
  }

  get options(): TorrentFurrowParams {
    return this.ctx.options;
  }

  private get peer_ctx(): TorrentPeerContext {
    return this.ctx.peer_ctx;
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
    const encrypted = await TorrentUtils.encrypt(
      message_body,
      this.ctx.swarm_key,
    );
    const mac = await TorrentUtils.generate_mac(encrypted, this.ctx.swarm_key);
    const encrypted_message = new TorrentMessage(
      TorrentUtils.buffer_to_base64(encrypted),
    );
    const encrypted_message_body = TorrentUtils.to_array_buffer(
      encrypted_message.body,
    );

    //should change to submit instead of publish
    //or insttead in the ctx publish method handle it
    const signature = await this.ctx.identity.sign(encrypted_message_body);
    this.peer_ctx.publish({
      type: "PUBLISH",
      seeder: {
        id: this.ctx.identifier,
        name: this.ctx.name,
      },
      furrow: {
        id: this.ctx.identifier,
        name: this.ctx.name,
      },
      message: {
        body: encrypted_message.body,
        properties: message?.properties,
        artifacts: {
          timestamp: Date.now(),
          mac,
          public_key: this.ctx.public_key,
          signature: TorrentUtils.buffer_to_base64(signature),
        },
      },
    });
  }

  bind(routing_key: string): void {
    this.ctx.routing_keys.add(routing_key);
    this._update_routing_keys();
  }

  unbind(routing_key: string): void {
    this.ctx.routing_keys.delete(routing_key);
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
    this.ctx.plant_callbacks.add(callback);
    return {
      unplant: () => {
        this.ctx.plant_callbacks.delete(callback);
      },
    };
  }

  private _update_routing_keys(): void {
    this.ctx.options = {
      ...this.ctx.options,
      routing_keys: Array.from(this.ctx.routing_keys),
    };
  }
}
