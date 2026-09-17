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

      args: {
        x_unsent_cache: true,
      },
    };

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg)
        options = {
          ...options,
          ...arg,
          args: { ...options.args, ...arg.args },
        };
    }

    this.peer_ctx = ctx;
    this.ctx = new TorrentSeederContext({ ctx, name, options });
  }

  get identifier(): string {
    return this.ctx.identifier;
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

    await this.ctx.publish(message);
  }

  furrow(
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ): TorrentFurrow {
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
