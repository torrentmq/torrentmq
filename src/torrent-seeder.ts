import { TORRENT_LEASE_DURATION } from "./torrent-consts";
import { TorrentEmitter } from "./torrent-emitter";
import { TorrentFurrow } from "./torrent-furrow";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";
import { TorrentPeer } from "./torrent-peer";
import {
  TorrentFurrowParams,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentSeederParams,
  TorrentHostedObj,
  TorrentCertificate,
  TorrentSeederFurrowSecurityObject,
  TorrentSeederFurrowMode,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentSeeder extends TorrentEmitter<
  | "created_furrow"
  | "seeder_promoted"
  | "seeder_demoted"
  | "furrow_promoted"
  | "furrow_demoted"
> {
  identifier: string;
  readonly peer: TorrentPeer;

  furrows: TorrentFurrow[] = [];

  pub_key: JsonWebKey;
  // when in follower mode request a cerificate from the "master"
  // or are certificates just not worth it?
  cert?: TorrentCertificate;
  private is_exchanging: boolean = false;
  private mode: TorrentSeederFurrowMode = "master";

  identity: TorrentIdentity;
  swarm_key: ArrayBuffer;

  private key_refresh_interval: ReturnType<typeof setInterval> | null = null;
  private pulse_interval: ReturnType<typeof setInterval> | null = null;
  private watchdog_timer: ReturnType<typeof setTimeout> | null = null;

  // random failover window to avoid collision
  private readonly failover_timeout: number =
    TORRENT_LEASE_DURATION + Math.random() * 1000;

  readonly name: string;
  readonly options: TorrentSeederParams;

  private constructor(
    peer: TorrentPeer,
    arg1?: string | TorrentSeederParams | TorrentSeederFurrowSecurityObject,
    arg2?: string | TorrentSeederParams | TorrentSeederFurrowSecurityObject,
    arg3?: string | TorrentSeederParams | TorrentSeederFurrowSecurityObject,
  ) {
    super();

    let name: string | undefined;
    let options: TorrentSeederParams | undefined;
    let security: TorrentSeederFurrowSecurityObject | undefined;

    for (const arg of [arg1, arg2, arg3]) {
      if (typeof arg === "string") name = arg;
      else if (TorrentUtils.is_security_object(arg)) security = arg;
      else if (arg) options = arg;
    }

    this.peer = peer;
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
    peer: TorrentPeer,
    arg1?: string | TorrentSeederParams,
    arg2?: string | TorrentSeederParams,
  ) {
    let name: string | undefined;
    let options: TorrentSeederParams | undefined;

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

    const seeder = new TorrentSeeder(peer, name, options, security_obj);

    // call find to start search
    peer.find({
      id: identifier,
      name,
    });

    return seeder;
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

    // NOTE: must have been drunk when i wrote this encryption and signing logic
    // it looks like a mess, but it works, so not going to change it for now
    // being drunk would have been a good excuse but i am just sober

    // also sign with our identity if we are the root

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
            this.peer.publish({
              ...send_message,
              seeder: {
                ...send_message.seeder,
                pub_key: this.pub_key,
              },
              artifacts: {
                ...send_message.artifacts,
                pub_key: this.pub_key,
                signature: TorrentUtils.to_base64_url(signature),
              },
            });
          });
        else this.peer.submit(send_message);
      });
    });
  }

  async furrow(
    arg1?: string | TorrentFurrowParams,
    arg2?: string | TorrentFurrowParams,
  ) {
    // for my latest magic trick
    let name: string | undefined;
    let options: TorrentFurrowParams | undefined;

    if (typeof arg1 === "string") {
      name = arg1;
      if (arg2 && typeof arg2 === "object") options = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      options = arg1;
      if (typeof arg2 === "string") name = arg2;
    }

    if (name) {
      const found_furrow = this.furrows.find((f) => f.name === name);
      if (found_furrow) return found_furrow;
    }

    const furrow = await TorrentFurrow.create(this, options, name);
    this.furrows.push(furrow);

    furrow.on({
      furrow_promoted: ({ furrow }: { furrow: TorrentHostedObj }) => {
        const pub_key = this.pub_key;
        const cert = this.cert ?? undefined;

        this.emit<{
          seeder: TorrentHostedObj;
          furrow: TorrentHostedObj;
        }>("furrow_promoted", {
          seeder: {
            id: this.identifier,
            name: this.name,
            mode: this.mode,
            ...(cert ? { cert } : { pub_key }),
            ...(this.options && Object.keys(this.options).length > 0
              ? { properties: { ...this.options } }
              : {}),
          },
          furrow,
        });
      },
      furrow_demoted: ({ id, name }: { id: string; name: string }) => {
        this.emit("furrow_demoted", {
          seeder: { id: this.identifier, name: this.name },
          furrow: { id, name },
        });
      },
    });

    // emit created furrow to update hosted
    this.emit<{
      seeder: TorrentHostedObj;
      furrow: TorrentHostedObj;
    }>("created_furrow", {
      seeder: {
        id: this.identifier,
        name: this.name,
        pub_key: this.pub_key,
        mode: this.mode,
        ...(this.options && Object.keys(this.options).length > 0
          ? { properties: { ...this.options } }
          : {}),
      },
      furrow: {
        id: furrow.identifier,
        name: furrow.name,
        pub_key: furrow.pub_key,
        mode: furrow.get_mode(),
        ...(furrow.options && Object.keys(furrow.options).length > 0
          ? { properties: { ...furrow.options } }
          : {}),
      },
    });

    return furrow;
  }

  get_swarm_key() {
    return this.swarm_key;
  }

  get_mode() {
    return this.mode;
  }

  private setup_event_listeners() {
    this.peer.on({
      eph_exchange_init: ({ name }: { id: string; name: string }) => {
        if (name === this.name) this.is_exchanging = true;
      },
      eph_exchange_complete: ({ name }: { id: string; name: string }) => {
        if (name === this.name) this.is_exchanging = false;
      },
      swarm_key_exchanged: ({
        seeder,
      }: {
        seeder: TorrentHostedObj & { swarm_key: ArrayBuffer };
        furrow?: TorrentHostedObj & { swarm_key: ArrayBuffer };
      }) => {
        if (this.name !== seeder.name) return;

        this.identifier = seeder.id;
        this.swarm_key = seeder.swarm_key;

        // if we receive a key from another root, we step down
        if (this.mode === "master") {
          this.mode = "shadow";
          this.emit("seeder_demoted", { id: this.identifier, name: this.name });
          this.start_intervals(); // re-syncs intervals to follower mode
        }

        // Re-register all bound furrows under the now-adopted seeder identifier
        for (const furrow of this.furrows) {
          if (furrow.is_bound) {
            furrow.unbind(furrow["routing_key"]);
            furrow.bind(furrow["routing_key"]);
          }
        }
      },
      pulse: ({
        seeder,
        furrow,
      }: {
        seeder: {
          id: string;
          name: string;
          term?: number;
        };
        furrow?: {
          id: string;
          name: string;
          term: number;
        };
      }) => {
        const { term, name, id } = seeder;

        if (name !== this.name || this.is_exchanging) return;
        if (!term) return;

        const now = Date.now();
        if (id !== this.identifier) {
          if (term && term > now) {
            if (this.mode === "master") this.demote_from_root();
            this.reset_watchdog();
          } else if (this.identifier.localeCompare(id) < 0) {
            // if lease expired or missing tie-break
            this.peer.find({ id, name });
            this.demote_from_root();
          }
        } else {
          if (this.mode === "shadow") this.reset_watchdog();
          else this.demote_from_root();
        }
      },
    });
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
        this.peer.swarm_key_refresh({ id: this.identifier, name: this.name });
      }, this.options.key_refresh ?? 600000);

      this.pulse_interval = setInterval(() => {
        this.peer.send_pulse(Date.now() + TORRENT_LEASE_DURATION, {
          id: this.identifier,
          name: this.name,
        });
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
      seeder: TorrentHostedObj;
    }>("seeder_promoted", {
      seeder: {
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
    this.peer.send_pulse(Date.now() + TORRENT_LEASE_DURATION, {
      id: this.identifier,
      name: this.name,
    });
  }

  private demote_from_root() {
    if (this.mode === "shadow") return;
    this.mode = "shadow";
    this.emit("seeder_demoted", { id: this.identifier, name: this.name });
    this.stop_all_timers();
    this.reset_watchdog();
  }
}
