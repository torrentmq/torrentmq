import { TorrentUtils } from "./torrent-utils";
import {
  TorrentSeederParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentControlMessage,
  TorrentSignalMessage,
} from "./torrent-types";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentFurrow } from "./torrent-furrow";
import { TorrentContext } from "./torrent-context";
import { TorrentMessage } from "./torrent-message";

export class TorrentSeeder {
  protected identity!: TorrentIdentity;
  private _identifier!: string;
  public_key!: JsonWebKey;
  swarm_key!: ArrayBuffer;

  protected ctx: TorrentContext;
  protected furrows: Map<string, TorrentFurrow> = new Map();

  readonly name: string;
  readonly options: TorrentSeederParams;

  constructor(
    ctx: TorrentContext,
    arg1?: string | TorrentSeederParams,
    arg2?: string | TorrentSeederParams,
  ) {
    this.ctx = ctx;

    let name: string = TorrentUtils.random_string();
    let options: TorrentSeederParams = {
      passive: false,
      durable: false,
      auto_delete: false,
      // key_refresh: 60000,

      type: "direct",
      internal: false,

      args: undefined,
    };

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = { ...options, ...arg };
    }

    this.name = name;
    this.options = options;

    this._initialize().then();
    this._attach_handlers();
  }

  get identifier(): string {
    return this._identifier;
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

  private _attach_handlers(): void {
    this.ctx.store.on<TorrentControlMessage | TorrentSignalMessage>(
      "set",
      (msg) => {
        if (!TorrentUtils.is_control_message(msg)) return;
        // handle relevant messages
      },
    );
  }

  private async _initialize(): Promise<void> {
    this.identity = await TorrentIdentity.create();
    this._identifier = await this.identity.get_identifier();
    this.public_key = (await this.identity.export_public_key()) as JsonWebKey;
    this.swarm_key = await TorrentUtils.generate_swarm_key();
  }
}
