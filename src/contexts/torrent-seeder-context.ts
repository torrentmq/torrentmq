import { TorrentUtils } from "../torrent-utils";
import type {
  TorrentSeederFurrowMode,
  TorrentControlMessage,
  TorrentSignalMessage,
  TorrentSeederParams,
} from "../torrent-types";
import type { TorrentPeerContext } from "./torrent-peer-context";
import { TorrentMessage } from "../torrent-message";
import { TorrentError } from "../torrent-error";
import { TorrentIdentity } from "../torrent-identity";
import { TorrentEphemeral } from "../torrent-ephemeral";

export class TorrentSeederContext {
  protected identity!: TorrentIdentity;
  private _identifier!: string;
  private public_key!: JsonWebKey;
  // Double-Buffered Key
  // index 0 is priority this is the expected current swarm key
  // whilst index 1 is the old key which will be removed after a grace period
  private _swarm_keys!: ArrayBuffer[];

  readonly ctx: TorrentPeerContext;

  readonly name: string;
  readonly options: TorrentSeederParams;

  readonly unsent?: Set<TorrentMessage>;

  private mode: TorrentSeederFurrowMode = "WAITING";
  private current: { root: string; term: number } = {
    root: "",
    term: 0,
  };

  protected eph_exchanges: Map<string, TorrentEphemeral> = new Map();

  private pulse_interval: ReturnType<typeof setInterval> | null = null;
  private swarm_key_interval: ReturnType<typeof setInterval> | null = null;
  private election_timeout: ReturnType<typeof setTimeout> | null = null;

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
    if (
      typeof options?.args?.["x_unsent_cache"] === "boolean" &&
      options?.args?.["x_unsent_cache"] === true
    )
      this.unsent = new Set();

    this._initialize().then();
    this._reset_election_timeout();
    this._attach_handlers();
  }

  get identifier(): string {
    return this._identifier;
  }

  get swarm_keys(): ArrayBuffer[] {
    return this._swarm_keys;
  }

  async publish(msg: TorrentMessage): Promise<void> {
    if (this.mode === "WAITING" && this.unsent) this.unsent.add(msg);
    else {
      const message_body = TorrentUtils.to_array_buffer(msg.body);
      const active_swarm_key = this._swarm_keys[0]!;
      const encrypted = await TorrentUtils.encrypt(
        message_body,
        active_swarm_key,
      );
      const mac = await TorrentUtils.generate_mac(encrypted, active_swarm_key);
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
      const signature = await this.identity.sign(encrypted_message_body);

      this.ctx.publish({
        type: "PUBLISH",
        seeder: { id: this.ctx.identifier, name: this.name },
        message: {
          body: encrypted_message.body,
          properties: msg?.properties,
          artifacts: {
            timestamp: Date.now(),
            mac,
            public_key: this.public_key,
            signature: TorrentUtils.buffer_to_base64(signature),
          },
        },
      });
    }
  }

  private async _flush_unsent(): Promise<void> {
    if (this.mode === "WAITING" || !this.unsent) return;

    for (const msg of [...this.unsent]) {
      this.publish(msg);
      this.unsent.delete(msg);
    }
  }

  private _start_swarm_key_interval(): void {
    if (this.swarm_key_interval) {
      clearInterval(this.swarm_key_interval);
      this.swarm_key_interval = null;
    }

    this.swarm_key_interval = setInterval(async () => {
      const new_swarm_key = await TorrentUtils.generate_swarm_key();
      this._set_swarm_key(new_swarm_key);

      this.ctx.publish({
        type: "SWARM_KEY_REFRESH",
        seeder: { id: this._identifier, name: this.name },
      });
    }, this.options.key_refresh);
  }

  private _start_pulse_interval(): void {
    if (this.pulse_interval) {
      clearInterval(this.pulse_interval);
      this.pulse_interval = null;
    }

    const timeout = TorrentUtils.calculate_timeout(this.ctx.connected_peers);

    this.pulse_interval = setInterval(() => {
      this.ctx.publish({
        type: "PULSE",
        seeder: { id: this._identifier, name: this.name },
        term: this.current.term,
        options: this.options,
      });
    }, timeout);
  }

  private _clear_intervals(): void {
    if (this.pulse_interval) {
      clearInterval(this.pulse_interval);
      this.pulse_interval = null;
    }

    if (this.swarm_key_interval) {
      clearInterval(this.swarm_key_interval);
      this.swarm_key_interval = null;
    }
  }

  private _reset_election_timeout(): void {
    if (this.election_timeout) {
      clearTimeout(this.election_timeout);
      this.election_timeout = null;
    }

    const random_multiplier = 0.75 + Math.random() * 0.75;
    const base = TorrentUtils.calculate_timeout(this.ctx.connected_peers);
    const timeout = Math.min(
      Math.max(base * random_multiplier, 10_000),
      60_000,
    );

    this.election_timeout = setTimeout(() => {
      this.current = { root: this._identifier, term: this.current.term + 1 };
      this.eph_exchanges.clear();
      this.mode = "ROOT";

      if (this.election_timeout) {
        clearTimeout(this.election_timeout);
        this.election_timeout = null;
      }

      this._start_pulse_interval();
      this._start_swarm_key_interval();

      this._flush_unsent();
    }, timeout);
  }

  private _set_swarm_key(new_key: ArrayBuffer) {
    const old_key = this._swarm_keys[0];
    this._swarm_keys = [new_key, old_key].filter(Boolean) as ArrayBuffer[];

    if (!old_key) return;
    const refresh_interval = this.options.key_refresh ?? 600000;
    const grace_period = refresh_interval * 0.8;

    setTimeout(() => {
      if (this._swarm_keys[1] === old_key) {
        this._swarm_keys.splice(1, 1);
      }
    }, grace_period);
  }

  private _attach_handlers(): void {
    this.ctx.store.on<TorrentControlMessage | TorrentSignalMessage>(
      "set",
      async (msg) => {
        if (!TorrentUtils.is_control_message(msg)) return;
        if (msg.from === this.ctx.identifier) return;
        if (msg.seeder.name !== this.name || msg.furrow) return;
        switch (msg.type) {
          case "PULSE": {
            if (msg.term < this.current.term) return;
            if (
              msg.term === this.current.term &&
              msg.seeder.id === this.current.root
            ) {
              this.mode = "SHADOW";
              this._clear_intervals();
              this._reset_election_timeout();
              return;
            }
            if (
              msg.term > this.current.term ||
              (msg.term === this.current.term &&
                msg.seeder.id.localeCompare(this.current.root) < 0)
            ) {
              // we heard from the current leader, so step down if we thought
              // we were the leader, and wait for the next pulse before we
              // consider starting a new election.
              this.mode = "WAITING";
              this._clear_intervals();

              this.current = { root: msg.seeder.id, term: msg.term };

              this._reset_election_timeout();

              const exchange = this.eph_exchanges.get(msg.from);
              if (exchange) return;
              // send message to init swarm key exchange
              const eph_key = await TorrentEphemeral.create();
              this.eph_exchanges.set(msg.from, eph_key);

              const eph_public_key_array_buffer: ArrayBuffer =
                (await eph_key.export_public_key("raw")) as ArrayBuffer;

              this.ctx.publish({
                type: "EPH_KEY_OFFER",
                to: msg.from,
                seeder: { id: this._identifier, name: this.name },
                eph_public_key: TorrentUtils.buffer_to_base64(
                  eph_public_key_array_buffer,
                ),
              });
            }
            break;
          }

          case "SWARM_KEY_REFRESH": {
            if (this.current.root !== msg.seeder.id) return;

            this.mode = "WAITING";

            const eph_key = await TorrentEphemeral.create();
            this.eph_exchanges.set(msg.from, eph_key);

            const eph_public_key_array_buffer: ArrayBuffer =
              (await eph_key.export_public_key("raw")) as ArrayBuffer;

            this.ctx.publish({
              type: "EPH_KEY_OFFER",
              to: msg.from,
              seeder: { id: this._identifier, name: this.name },

              eph_public_key: TorrentUtils.buffer_to_base64(
                eph_public_key_array_buffer,
              ),
            });
            break;
          }

          case "EPH_KEY_OFFER": {
            if (this.mode !== "ROOT" || this.eph_exchanges.size > 0) return;
            const eph_key = await TorrentEphemeral.create();
            const active_swarm_key = this._swarm_keys[0]!;

            const signature = await this.identity.sign(
              TorrentUtils.base64_to_buffer(msg.eph_public_key),
            );
            const eph_public_key_array_buffer: ArrayBuffer =
              (await eph_key.export_public_key("raw")) as ArrayBuffer;
            const aes_salt = TorrentUtils.generate_salt();

            const aes_key = await TorrentUtils.create_aes_key(
              (await eph_key.export_private_key("crypto")) as CryptoKey,
              TorrentUtils.base64_to_buffer(msg.eph_public_key),
              aes_salt,
            );
            const encrypted_swarm_key_array_buffer = await TorrentUtils.encrypt(
              active_swarm_key,
              aes_key,
            );

            this.ctx.publish({
              type: "EPH_KEY_EXCHANGE",
              to: msg.from,
              seeder: { id: this._identifier, name: this.name },
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
            if (msg.to !== this.ctx.identifier) return;
            const exchange = this.eph_exchanges.get(msg.from);
            if (!exchange) return;

            const valid = await TorrentUtils.verify_with_key(
              (await exchange.export_public_key("raw")) as ArrayBuffer,
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
              (await exchange.export_private_key("crypto")) as CryptoKey,
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
            this._set_swarm_key(swarm_key);
            this.mode = "SHADOW"; // ensure to change mode to SHADOW
            this.eph_exchanges.delete(msg.from); // ensure to unset
            // reset all intervals in initiate watch for pulses
            this._clear_intervals();
            this._reset_election_timeout();

            this._flush_unsent();
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
    this._set_swarm_key(await TorrentUtils.generate_swarm_key());
  }
}
