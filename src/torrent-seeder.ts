import { TorrentUtils } from "./torrent-utils";
import type {
  TorrentSeederParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentFurrowParams,
} from "./torrent-types";
import type { TorrentPeerContext } from "./contexts/torrent-peer-context";
import { TorrentSeederContext } from "./contexts/torrent-seeder-context";
import { TorrentFurrow } from "./torrent-furrow";
import { TorrentMessage } from "./torrent-message";

export class TorrentSeeder {
  private peer_ctx: TorrentPeerContext;
  private ctx: TorrentSeederContext;
  private furrows: Map<string, TorrentFurrow> = new Map();

  constructor(
    ctx: TorrentPeerContext,
    arg1?: string | TorrentSeederParams,
    arg2?: string | TorrentSeederParams,
  ) {
    let name: string = TorrentUtils.random_string();
    let options: TorrentSeederParams = {
      passive: false,
      durable: false,
      auto_delete: false,
      key_refresh: 600_000,

      type: "direct",
      internal: false,

      args: undefined,
    };

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = { ...options, ...arg };
    }

    this.peer_ctx = ctx;
    this.ctx = new TorrentSeederContext({ ctx, name, options });
  }

  get name(): string {
    return this.ctx.name;
  }

  get options(): TorrentSeederParams {
    return this.ctx.options;
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
      source: this.peer_ctx.identifier,
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

    // should change to submit instead of publish
    // or insttead in the ctx publish method handle it
    // wrong just publish the message and sign it yourself
    // all we care about is the message decryption tbh
    const signature = await this.ctx.identity.sign(encrypted_message_body);
    this.peer_ctx.publish({
      type: "PUBLISH",
      from: this.peer_ctx.identifier,
      seeder: {
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

  furrow(
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ) {
    // if u couldn't tell arleady i copy and pasted this
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = arg;
    }

    if (name) {
      const existing = this.furrows.get(name);
      if (existing) return existing;
    }

    const furrow = new TorrentFurrow(this.ctx, name, options);
    this.furrows.set(furrow.name, furrow);

    return furrow;
  }
}
