import { TorrentUtils } from "./torrent-utils";
import { TorrentError } from "./torrent-error";
import type {
  TorrentSeederParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentControlMessage,
  TorrentSignalMessage,
  TorrentFurrowParams,
  TorrentSeederFurrowMode,
} from "./torrent-types";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentFurrow } from "./torrent-furrow";
import { TorrentContext } from "./torrent-context";
import { TorrentMessage } from "./torrent-message";
import { TorrentEphemeral } from "./torrent-ephemeral";

export class TorrentSeeder {
  protected identity!: TorrentIdentity;
  private _identifier!: string;
  private public_key!: JsonWebKey;
  private swarm_key!: ArrayBuffer;

  private eph_aes_key?: TorrentEphemeral;
  private eph_key_exchange?: Promise<TorrentEphemeral>;

  protected ctx: TorrentContext;
  protected furrows: Map<string, TorrentFurrow> = new Map();

  readonly name: string;
  readonly options: TorrentSeederParams;

  private mode: TorrentSeederFurrowMode = "ROOT";
  private current_term: number = 1;
  readonly created_at: number = Date.now();
  private pulse_interval: ReturnType<typeof setInterval> | null = null;

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
    this._start_intervals();
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

    const furrow = new TorrentFurrow(
      this.ctx,
      {
        name: this.name,
        swarm_key: this.swarm_key,
        public_key: this.public_key,
      },
      name,
      options,
    );
    this.furrows.set(furrow.name, furrow);

    return furrow;
  }

  private _start_intervals(): void {
    this.pulse_interval = setInterval(() => {
      this.ctx.publish({
        type: "PULSE",
        from: this.ctx.identifier,
        seeder: {
          id: this.identifier,
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
                id: this.identifier,
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

            const signature = await this.identity.sign(
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
              this.swarm_key,
              aes_key,
            );
            console.log(aes_key, encrypted_swarm_key_array_buffer);

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
                identity_public_key: this.public_key,
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
            console.log(aes_key, encrypted_swarm_key);
            const swarm_key = await TorrentUtils.decrypt(
              encrypted_swarm_key,
              aes_key,
            );

            if (!swarm_key) return;
            this.swarm_key = swarm_key;
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
    this.identity = await TorrentIdentity.create();
    this._identifier = await this.identity.get_identifier();
    this.public_key = (await this.identity.export_public_key()) as JsonWebKey;
    this.swarm_key = await TorrentUtils.generate_swarm_key();
  }
}
