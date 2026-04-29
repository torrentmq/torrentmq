import { TorrentEmitter } from "./torrent-emitter";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";
import { TorrentSeeder } from "./torrent-seeder";
import {
  TorrentCallBack,
  TorrentConsumeParams,
  TorrentControlMessage,
  TorrentFurrowParams,
  TorrentHostedObj,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentCertificate,
  TorrentSeederFurrowMode,
  TorrentSeederFurrowSecurityObject,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentFurrow extends TorrentEmitter<
  "furrow_promoted" | "furrow_demoted"
> {
  identifier: string;
  protected readonly seeder: TorrentSeeder;

  is_planted: boolean | "unset" = "unset";
  is_bound: boolean = false;
  private routing_key: string | undefined;

  pub_key: JsonWebKey;
  cert?: TorrentCertificate;
  private is_exchanging: boolean = false;
  private mode: TorrentSeederFurrowMode = "master";

  identity: TorrentIdentity;
  protected swarm_key: ArrayBuffer;

  private key_refresh_interval: ReturnType<typeof setInterval> | null = null;
  private pulse_interval: ReturnType<typeof setInterval> | null = null;
  private watchdog_timer: ReturnType<typeof setTimeout> | null = null;

  // random failover window to avoid collision
  private readonly failover_timeout: number = 2000 + Math.random() * 1000;

  readonly name: string;
  readonly options: TorrentFurrowParams;

  private constructor(
    seeder: TorrentSeeder,
    arg1?: string | TorrentFurrowParams | TorrentSeederFurrowSecurityObject,
    arg2?: string | TorrentFurrowParams | TorrentSeederFurrowSecurityObject,
    arg3?: string | TorrentFurrowParams | TorrentSeederFurrowSecurityObject,
  ) {
    super();

    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;
    let security: TorrentSeederFurrowSecurityObject | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (typeof arg === "string") name = arg;
      else if (TorrentUtils.is_security_object(arg)) security = arg;
      else if (arg) options = arg;
    }

    this.seeder = seeder;
    this.name = name ?? TorrentUtils.random_string();
    this.options = options ?? {};

    if (security) {
      const { identity, identifier, pub_key, swarm_key } = security;

      this.identity = identity;
      this.identifier = identifier;
      this.pub_key = pub_key;
      this.swarm_key = swarm_key;
    }

    this.setup_event_listeners();
    this.start_intervals();
  }

  static async create(
    seeder: TorrentSeeder,
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ) {
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = arg;
    }

    name = name ?? TorrentUtils.random_string();

    const identity: TorrentIdentity = await TorrentIdentity.create();
    const identifier: string = await identity.get_identifier();
    const pub_key: JsonWebKey = await identity.export_public_jwk();
    const swarm_key: ArrayBuffer = await TorrentUtils._generate_swarm_key();
    const security_obj: TorrentSeederFurrowSecurityObject = {
      identifier,
      identity,
      pub_key,
      swarm_key,
    };

    const furrow = new TorrentFurrow(seeder, name, options, security_obj);

    seeder.peer.find(
      {
        id: seeder.identifier,
        name: seeder.name,
      },
      {
        id: identifier,
        name,
      },
    );

    return furrow;
  }

  send(
    arg1?: TorrentMessageBody | TorrentMessageParams,
    arg2?: TorrentMessageBody | TorrentMessageParams,
  ) {
    let body: TorrentMessageBody | undefined;
    let params: TorrentMessageParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (TorrentUtils.is_message_params(arg)) params = arg;
      else if (arg !== undefined) body = arg;
    }

    const message = new TorrentMessage(body || null, params);
    const message_body = TorrentUtils.to_array_buffer(message.body);

    TorrentUtils.encrypt(message_body, this.swarm_key).then((encrypted) => {
      TorrentUtils.generate_mac(encrypted, this.swarm_key).then((mac) => {
        const encrypted_message = new TorrentMessage(
          TorrentUtils.to_base64_url(encrypted),
        );
        const encrypted_message_body = TorrentUtils.to_array_buffer(
          encrypted_message.body,
        );

        const send_message = {
          seeder: {
            id: this.seeder.identifier,
            name: this.seeder.name,
          },
          furrow: {
            id: this.identifier,
            name: this.name,
          },

          message,
          encrypted_message,
          artifacts: {
            timestamp: Date.now(),
            mac,
          },
        };

        if (this.mode === "master")
          this.identity.sign(encrypted_message_body).then((signature) => {
            this.seeder.peer.publish({
              ...send_message,
              seeder: {
                ...send_message.seeder,
                pub_key: this.seeder.pub_key,
              },
              furrow: {
                ...send_message.furrow,
                pub_key: this.pub_key,
              },
              artifacts: {
                ...send_message.artifacts,
                pub_key: this.pub_key,
                signature: TorrentUtils.to_base64_url(signature),
              },
            });
          });
        else this.seeder.peer.submit(send_message);
      });
    });
  }

  plant(
    arg1?: TorrentCallBack | TorrentConsumeParams,
    arg2?: TorrentCallBack | TorrentConsumeParams,
  ) {
    let callback: TorrentCallBack | undefined;
    let params: TorrentConsumeParams | undefined;

    if (typeof arg1 === "function") {
      callback = arg1;
      if (arg2 && typeof arg2 === "object") params = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      params = arg1;
      if (typeof arg2 === "function") callback = arg2;
    }

    if (this.is_planted !== "unset") this.is_planted = true;
    if (callback)
      this.seeder.peer.on<Extract<TorrentControlMessage, { type: "PUBLISH" }>>(
        "message_receive",
        (msg) => {
          if (msg.seeder.id !== this.seeder.identifier) return;
          if (msg.furrow && msg.furrow.id !== this.identifier) return;

          const swarm_key = msg.furrow ? this.swarm_key : this.seeder.swarm_key;

          TorrentIdentity.verify(
            TorrentUtils.to_array_buffer(msg.message.body),
            TorrentUtils.from_base64_url(msg.message.artifacts.signature),
            msg.message.artifacts.pub_key,
          ).then((valid) => {
            if (!valid) return;

            TorrentUtils.verify_mac(
              TorrentUtils.from_base64_url(msg.message.body as string),
              swarm_key,
              msg.message.artifacts.mac,
            ).then((valid) => {
              if (!valid) return;

              TorrentUtils.decrypt(
                TorrentUtils.from_base64_url(msg.message.body as string),
                swarm_key,
              ).then((decrypted_msg) => {
                if (!decrypted_msg) return;
                const message_body =
                  TorrentUtils.from_array_buffer(decrypted_msg);
                const message = new TorrentMessage(
                  message_body as TorrentMessageBody,
                  msg.message.properties,
                );

                if (this.is_planted) callback?.(message);
              });
            });
          });
        },
      );
  }

  unplant() {
    this.is_planted = false;
  }

  bind(routing_key?: string) {
    if (routing_key) this.routing_key = routing_key;
    this.is_bound = true;

    this.seeder.peer.register_remote_binding(
      {
        id: this.seeder.identifier,
        name: this.seeder.name,
        pub_key: this.seeder.pub_key,
      },
      {
        id: this.identifier,
        name: this.name,
        routing_key,
      },
    );
  }

  unbind(routing_key?: string) {
    if (routing_key) this.routing_key = routing_key;
    this.is_bound = false;

    this.seeder.peer.unregister_remote_binding(
      {
        id: this.seeder.identifier,
        name: this.seeder.name,
        pub_key: this.seeder.pub_key,
      },
      {
        id: this.identifier,
        name: this.name,
        routing_key,
      },
    );
  }

  get_swarm_key() {
    return this.swarm_key;
  }

  get_mode() {
    return this.mode;
  }

  private setup_event_listeners() {
    this.seeder.peer.on<{ id: string; name: string }>(
      "eph_exchange_init",
      ({ name }) => {
        if (name === this.name) this.is_exchanging = true;
      },
    );

    this.seeder.peer.on<{ id: string; name: string }>(
      "eph_exchange_complete",
      ({ name }) => {
        if (name === this.name) this.is_exchanging = false;
      },
    );

    this.seeder.peer.on<{
      seeder: TorrentHostedObj & { swarm_key: ArrayBuffer };
      furrow?: TorrentHostedObj & { swarm_key: ArrayBuffer };
    }>("swarm_key_exchanged", ({ furrow }) => {
      if (!furrow || this.name !== furrow.name) return;

      if (this.is_bound) this.unbind(this.routing_key);

      this.identifier = furrow.id;
      this.swarm_key = furrow.swarm_key;

      // if we receive a key from another root, we step down
      if (this.mode === "master") {
        this.mode = "shadow";
        // force remove from list of hosted furrows
        this.emit("furrow_demoted", { id: this.identifier, name: this.name });
        this.start_intervals(); // re-syncs intervals to shadow mode
      }

      this.bind(this.routing_key);
    });

    // pulse monitoring for failover
    this.seeder.peer.on<{ id: string; name: string }>(
      "furrow_pulse",
      ({ id, name }) => {
        if (name === this.name && !this.is_exchanging) {
          if (this.identifier.localeCompare(id) < 0)
            this.seeder.peer.find(
              {
                id: this.seeder.identifier,
                name: this.seeder.name,
              },
              {
                id: this.identifier,
                name: this.name,
              },
            );

          if (this.mode === "master") this.demote_from_root();
          else this.reset_watchdog();
        }
      },
    );
  }

  private start_intervals() {
    this.stop_all_timers();

    if (this.mode === "master") {
      let first_cycle = true;
      this.key_refresh_interval = setInterval(async () => {
        if (first_cycle === true) {
          first_cycle = false;
          return;
        }

        if (this.is_exchanging) return;
        this.swarm_key = await TorrentUtils._generate_swarm_key();
        this.seeder.peer.swarm_key_refresh(
          { id: this.seeder.identifier, name: this.seeder.name },
          { id: this.identifier, name: this.name },
        );
      }, this.options.key_refresh ?? 600000);

      this.pulse_interval = setInterval(() => {
        this.seeder.peer.send_pulse(
          { id: this.seeder.identifier, name: this.seeder.name },
          { id: this.identifier, name: this.name },
        );
      }, 1000);
    } else this.reset_watchdog();
  }

  private reset_watchdog() {
    this.stop_watchdog();
    this.watchdog_timer = setTimeout(() => {
      this.promote_to_root();
    }, this.failover_timeout);
  }

  private stop_watchdog() {
    if (this.watchdog_timer) clearTimeout(this.watchdog_timer);
    this.watchdog_timer = null;
  }

  private stop_all_timers() {
    if (this.key_refresh_interval) clearInterval(this.key_refresh_interval);
    if (this.pulse_interval) clearInterval(this.pulse_interval);
    if (this.watchdog_timer) clearTimeout(this.watchdog_timer);

    this.key_refresh_interval = null;
    this.pulse_interval = null;
    this.watchdog_timer = null;
  }

  private promote_to_root() {
    if (this.mode === "master") return;
    this.mode = "master";

    const pub_key = this.pub_key;
    const cert = this.cert ?? undefined;

    this.emit<{
      furrow: TorrentHostedObj;
    }>("furrow_promoted", {
      furrow: {
        id: this.identifier,
        name: this.name,
        mode: this.mode,
        ...(cert ? { cert } : { pub_key }),
        ...(this.options && Object.keys(this.options).length > 0
          ? { properties: { ...this.options } }
          : {}),
      },
    });

    this.start_intervals();

    // use pulse to signal dominance
    this.seeder.peer.send_pulse(
      { id: this.seeder.identifier, name: this.seeder.name },
      { id: this.identifier, name: this.name },
    );
  }

  private demote_from_root() {
    if (this.mode === "shadow") return;
    this.mode = "shadow";
    this.emit("furrow_demoted", { id: this.identifier, name: this.name });
    this.stop_all_timers();
    this.reset_watchdog();
  }
}
