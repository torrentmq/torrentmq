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
  TorrentSeederCertificate,
  TorrentSeederFurrowSecurityObject,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentSeeder extends TorrentEmitter<"created_furrow"> {
  identifier: string;
  readonly peer: TorrentPeer;

  furrows: TorrentFurrow[] = [];

  pub_key: JsonWebKey;
  cert?: TorrentSeederCertificate;
  is_root: boolean = true;

  identity: TorrentIdentity;
  swarm_key: ArrayBuffer;

  private key_refresh_interval: ReturnType<typeof setInterval> | null = null;
  private pulse_interval: ReturnType<typeof setInterval> | null = null;

  private last_pulse_received: number = Date.now();
  // random failover window to avoid collision
  private readonly failover_timeout: number = 9000 + Math.random() * 3000;

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
      name: this.name,
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

        if (this.is_root)
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

    const furrow = await TorrentFurrow.create(this, options, name);
    this.furrows.push(furrow);

    // emit created furrow to update hosted
    this.emit<{
      seeder: TorrentHostedObj;
      furrow: TorrentHostedObj;
    }>("created_furrow", {
      seeder: {
        id: this.identifier,
        name: this.name,
        pub_key: this.pub_key,
        ...(this.options && Object.keys(this.options).length > 0
          ? { properties: { ...this.options } }
          : {}),
      },
      furrow: {
        id: furrow.identifier,
        name: furrow.name,
        pub_key: furrow.pub_key,
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

  private setup_event_listeners() {
    this.peer.on<{
      seeder: TorrentHostedObj & { swarm_key: ArrayBuffer };
      furrow?: TorrentHostedObj & { swarm_key: ArrayBuffer };
    }>("swarm_key_exchanged", ({ seeder, furrow }) => {
      if (this.name !== seeder.name) return;

      this.identifier = seeder.id;
      this.swarm_key = seeder.swarm_key;

      // if we receive a key from another root, we step down
      if (this.is_root) {
        this.is_root = false;
        this.start_intervals(); // re-syncs intervals to follower mode
      }
    });

    // pulse monitoring for failover
    this.peer.on<{ id: string; name: string }>("pulse", ({ id, name }) => {
      if (id === this.identifier && name === this.name) {
        this.last_pulse_received = Date.now();
      }
    });
  }

  private start_intervals() {
    this.stop_key_refresh();
    this.stop_pulsating();

    if (this.is_root) {
      this.key_refresh_interval = setInterval(async () => {
        this.swarm_key = await TorrentUtils._generate_swarm_key();
        this.peer.swarm_key_refresh({ id: this.identifier, name: this.name });
      }, this.options.key_refresh ?? 600000);

      this.pulse_interval = setInterval(() => {
        this.peer.send_pulse({ id: this.identifier, name: this.name });
      }, 3000);
    } else
      this.pulse_interval = setInterval(() => {
        const time_since_last_pulse = Date.now() - this.last_pulse_received;
        if (time_since_last_pulse > this.failover_timeout) {
          this.promote_to_root();
        }
      }, 3000);
  }

  private stop_key_refresh() {
    if (this.key_refresh_interval) clearInterval(this.key_refresh_interval);
    this.key_refresh_interval = null;
  }

  private stop_pulsating() {
    if (this.pulse_interval) clearInterval(this.pulse_interval);
    this.pulse_interval = null;
  }

  private promote_to_root() {
    this.is_root = true;
    this.start_intervals();

    // use pulse to signal dominance
    this.peer.send_pulse({ id: this.identifier, name: this.name });
  }
}
