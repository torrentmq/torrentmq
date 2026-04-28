import { TorrentDHTNode } from "./torrent-dht";
import { TorrentEphemeral } from "./torrent-ephemeral";
import { TorrentError } from "./torrent-error";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";
import { TorrentSeeder } from "./torrent-seeder";
import {
  TorrentBrokerHost,
  TorrentControlMessage,
  TorrentFurrowBindingObj,
  TorrentSeederBindingObj,
  TorrentSeederParams,
  TorrentControlSeederOrFurrow,
  TorrentMessageObject,
  TorrentControlSeeder,
  TorrentHostedObj,
  TorrentControlBindFurrow,
  TorrentControlFurrow,
  TorrentMessageObjectWithoutSig,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

// Some days I think about blowing my top smoov off but today is not that day
export class TorrentPeer extends TorrentDHTNode {
  // the hosted seeders and or furrows [seeeder_name] -> [furrow_name][]
  private hosted: TorrentBrokerHost = new Map();
  protected seeders: TorrentSeeder[] = [];
  // id and eph_key for seeder connection [seeder_id] -> [TorrentEphemeral, aes_key]
  // keys should be deleted after swarm_key is sent
  protected eph_aes_keys: Map<
    string,
    { ephemeral: TorrentEphemeral; aes_key?: CryptoKey }
  > = new Map();
  private is_connected: boolean = false;

  constructor(options?: {
    ws_url?: string;
    min_peer_cluster_size?: number;
    max_peer_cluster_size?: number;
    status_frequency?: number;
    partion_heal_interval?: number;
    lru_size?: number;
  }) {
    super(options);

    // Handlers from dht node
    this.on<{ parsed: TorrentControlMessage; remote_id: string }>(
      "control_message",
      (data) => {
        this._handle_control_message(data.parsed, data.remote_id);
      },
    );

    this.on<{ peer_id: string }>(
      "signaller_connected",
      () => (this.is_connected = true),
    );
  }

  // User methods

  async seeder(
    arg1?: string | TorrentSeederParams,
    arg2?: string | TorrentSeederParams,
  ) {
    if (!this.is_connected)
      throw new TorrentError("You must connect to an RTC client");
    let name: string | undefined;
    let options: TorrentSeederParams | undefined;

    if (typeof arg1 === "string") {
      name = arg1;
      if (arg2 && typeof arg2 === "object") options = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      options = arg1;
      if (typeof arg2 === "string") name = arg2;
    }

    const seeder = await TorrentSeeder.create(this, name, options);
    this.seeders.push(seeder);

    const pub_key = seeder.pub_key;
    const cert = seeder.cert ?? undefined;

    this._add_to_hosted({
      id: seeder.identifier,
      name: seeder.name,
      mode: seeder.get_mode(),
      ...(cert ? { cert } : { pub_key }),
      ...(options && Object.keys(options).length > 0
        ? { properties: { ...options } }
        : {}),
    });

    seeder.on({
      seeder_promoted: ({ seeder }: { seeder: TorrentHostedObj }) => {
        this._add_to_hosted(seeder);
      },
      seeder_demoted: ({ name }: { id: string; name: string }) => {
        this._remove_from_hosted(name);
      },
      furrow_promoted: ({
        seeder,
        furrow,
      }: {
        seeder: TorrentHostedObj;
        furrow: TorrentHostedObj;
      }) => {
        this._add_to_hosted(seeder, furrow);
      },
      furrow_demoted: ({
        seeder,
        furrow,
      }: {
        seeder: { id: string; name: string };
        furrow: { id: string; name: string };
      }) => {
        this._remove_from_hosted(seeder.name, furrow.name);
      },
      created_furrow: ({
        seeder,
        furrow,
      }: {
        seeder: TorrentHostedObj;
        furrow: TorrentHostedObj;
      }) => {
        this._add_to_hosted(seeder, furrow);
      },
    });

    return seeder;
  }

  publish(msg: {
    seeder: TorrentControlSeeder;
    furrow?: TorrentControlFurrow;
    message: TorrentMessage;
    encrypted_message: TorrentMessage;
    artifacts: {
      mac: string;
      pub_key: JsonWebKey;
      timestamp: number;
      signature: string;
    };
  }) {
    const publish_msg: TorrentMessageObject = {
      body: msg.encrypted_message.body,
      properties: msg.message?.properties,
      artifacts: msg.artifacts,
    };

    const control: Omit<
      Extract<TorrentControlMessage, { type: "PUBLISH" }>,
      "artifacts" | "control_id"
    > = {
      type: "PUBLISH",
      from: this.identifier,
      seeder: msg.seeder,
      furrow: msg?.furrow,
      message: publish_msg,
    };

    // We broadcast a message to other peers and emit a PUBLISH event.
    // Broadcast to connected peers (DCs only) using broadcast_control
    this._broadcast_control(control);
    this.emit("publish", msg);
  }

  submit(msg: {
    seeder: TorrentControlSeederOrFurrow;
    furrow?: TorrentControlSeederOrFurrow;
    message: TorrentMessage;
    encrypted_message: TorrentMessage;
    artifacts: {
      mac: string;
      timestamp: number;
    };
  }) {
    const submit_msg: TorrentMessageObjectWithoutSig = {
      body: msg.encrypted_message.body,
      properties: msg.message?.properties,
      artifacts: msg.artifacts,
    };

    const control: Omit<
      Extract<TorrentControlMessage, { type: "SUBMIT" }>,
      "artifacts" | "control_id"
    > = {
      type: "SUBMIT",
      from: this.identifier,
      seeder: msg.seeder,
      furrow: msg?.furrow,
      message: submit_msg,
    };

    // send to peer that hosts the seeder/furrow
    // hosted seeder will sign and re-broadcast the message
    // just return a publish
    this._broadcast_control(control);
    this.emit("publish", msg);
  }

  find(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    const control: Omit<
      Extract<TorrentControlMessage, { type: "FIND" }>,
      "artifacts" | "control_id"
    > = {
      type: "FIND",
      from: this.identifier,
      seeder,
      furrow,
    };

    this._broadcast_control(control);
  }

  register_remote_binding(
    seeder: TorrentControlSeeder,
    furrow: TorrentControlBindFurrow,
  ) {
    this._bind_seeder_or_furrow(seeder, furrow);
    this._send_simple("ANNOUNCE_BIND", seeder, furrow);
    this.emit("bind", { seeder, furrow });
  }

  unregister_remote_binding(
    seeder: TorrentControlSeeder,
    furrow: TorrentControlBindFurrow,
  ) {
    this._unbind_seeder_or_furrow(seeder, furrow);
    this._send_simple("ANNOUNCE_UNBIND", seeder, furrow);
    this.emit("unbind", { seeder, furrow });
  }

  swarm_key_refresh(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    this._send_simple("SWARM_KEY_REFRESH", seeder, furrow);
  }

  send_pulse(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    this._send_simple("PULSE", seeder, furrow);
  }

  private _send_simple<
    T extends Extract<
      TorrentControlMessage["type"],
      "ANNOUNCE_BIND" | "ANNOUNCE_UNBIND" | "PULSE" | "SWARM_KEY_REFRESH"
    >,
  >(
    type: T,
    seeder: TorrentControlSeederOrFurrow | TorrentControlSeeder,
    furrow?: TorrentControlSeederOrFurrow | TorrentControlBindFurrow,
  ) {
    const control: Omit<
      Extract<TorrentControlMessage, { type: T }>,
      "artifacts" | "control_id"
    > = {
      type,
      from: this.identifier,
      seeder,
      furrow,
    } as any; // Cast used here because TS is such a whining bitch

    this._broadcast_control(control);
  }

  //  NOTE: All control traffic to DCs only. WebSocket signaling is used only for HELO/OFFER/ANSWER/ICE etc.
  private _broadcast_control(
    control: Omit<TorrentControlMessage, "control_id" | "artifacts">,
    to_peer_id?: string,
  ) {
    this._add_message_artifacts(control).then((artifacted_control) => {
      // if a target peer_id is given, send only to that peer (if open)
      if (to_peer_id) {
        const targeted = this.connected_peers.get(to_peer_id);
        if (targeted?.dc && targeted.dc.readyState === "open") {
          try {
            targeted.dc.send(JSON.stringify(artifacted_control));
          } catch (e) {
            console.warn("failed to send control to target peer", e);
          }
        }
        return;
      }

      if (artifacted_control.type !== "PUBLISH")
        // otherwise broadcast to all connected peers over DCs only
        for (const [, entry] of this.connected_peers) {
          if (entry.dc && entry.dc.readyState === "open") {
            try {
              entry.dc.send(JSON.stringify(artifacted_control));
            } catch (e) {
              console.warn("failed to broadcast control to peer", e);
            }
          }
        }
      else
        // use the weighted k-best forwarding alg
        this._forward_msg(artifacted_control);

      // store the message
      if (!this.data_store.has(artifacted_control.control_id))
        this.store(artifacted_control);
    });
  }

  private async _handle_control_message(
    control: TorrentControlMessage,
    remote_id?: string,
  ) {
    // NOTE: de-dup bullshit
    // ignore if message from self
    if (control.from === this.identifier) return;
    // already processed, skip entirely
    if (this.data_store.has(control.control_id)) return;
    if (control.to && control.to !== this.identifier) return;

    switch (control.type) {
      case "ANNOUNCE_BIND": {
        this._handle_bind(control);
        break;
      }

      case "ANNOUNCE_UNBIND": {
        this._handle_unbind(control);
        break;
      }

      case "LRU_STORE": {
        this._handle_lru_store(control);
        break;
      }

      case "PUBLISH":
      case "SUBMIT":
      case "ACK":
      case "FIND":
      case "FOUND":
      case "NOT_FOUND":
      case "EPH_KEY_OFFER":
      case "EPH_KEY_EXCHANGE":
      case "SWARM_KEY_REFRESH":
      case "PULSE": {
        await this._handle_signed_control_msg(control, remote_id);
        break;
      }
    }

    // store in the data store so is ignored if re_delivered
    if (
      control.type !== "LRU_STORE" &&
      !this.data_store.has(control.control_id)
    ) {
      // always naively forward if not publish type
      // only forward if not seen before or sent by us
      if (control.type !== "PUBLISH") this._forward_msg_naive(control);
      this.store(control);
    }
  }

  private async _handle_signed_control_msg(
    control: Extract<
      TorrentControlMessage,
      {
        type: Exclude<
          TorrentControlMessage["type"],
          "ANNOUNCE_BIND" | "ANNOUNCE_UNBIND" | "LRU_STORE"
        >;
      }
    >,
    remote_id?: string,
  ) {
    const temp_control = control;
    // reset hop count for message verification
    if (temp_control.type === "PUBLISH")
      temp_control.message = {
        ...temp_control.message,
        properties: {
          ...temp_control.message.properties,
          headers: {
            ...temp_control.message?.properties?.headers,
            hop_count: 0,
          },
        },
      };
    const { control_id, artifacts, ...msg_body } = temp_control;
    const msg_bytes = TorrentUtils.to_array_buffer(msg_body);
    const valid = await TorrentIdentity.verify(
      msg_bytes,
      TorrentUtils.from_base64_url(artifacts.signature),
      artifacts.pub_key,
    );

    if (!valid) {
      this.emit("message_malformed", control);
      return;
    }

    switch (control.type) {
      case "PUBLISH": {
        this._handle_receive(control);
        break;
      }

      case "SUBMIT": {
        this._handle_submit(control);
        break;
      }

      case "ACK": {
        // TODO: ack handling (deliver to on_ack callbacks)
        this.emit("ack", {
          message_id: control.message_id,
          peer_id: remote_id,
        });
        break;
      }

      case "FIND": {
        this._handle_find(control);
        break;
      }

      case "FOUND": {
        await this._handle_found(control);
        break;
      }

      case "NOT_FOUND": {
        this.emit("not_found", { seeder: control.seeder });
        break;
      }

      case "EPH_KEY_OFFER": {
        await this._handle_eph_offer(control);
        break;
      }

      case "EPH_KEY_EXCHANGE": {
        await this._handle_eph_exchange(control);
        break;
      }

      case "SWARM_KEY_REFRESH": {
        this._handle_swarm_key_refresh(control);
        break;
      }

      case "PULSE": {
        this._handle_pulse(control);
        break;
      }
    }
  }

  private _handle_bind(
    msg: Extract<TorrentControlMessage, { type: "ANNOUNCE_BIND" }>,
  ) {
    // ensure peer entry has bb map
    const peer = this.connected_peers.get(msg.from);
    if (peer && !peer.bb) peer.bb = new Map();
    if (!peer?.bb) return;

    const seeder_key: TorrentSeederBindingObj = {
      id: msg.seeder.id,
      name: msg.seeder.name,
    };
    let furrow_set = peer.bb.get(this.utils.serialize_binding(seeder_key));

    if (!furrow_set) {
      // If no furrows are bound to this seeder yet, create a new Set
      furrow_set = new Set();
      peer.bb.set(this.utils.serialize_binding(seeder_key), furrow_set);
    }

    // If a furrow is provided, add the furrow to the set for this seeder
    if (msg.furrow?.id && msg.furrow?.name) {
      const furrow_key: TorrentFurrowBindingObj = {
        id: msg.furrow.id,
        name: msg.furrow.name,
        routing_key: msg.furrow.routing_key ?? msg.from,
      };

      furrow_set.add(this.utils.serialize_binding(furrow_key));
    }

    this.emit("peer_bind", {
      seeder: msg.seeder,
      furrow: msg.furrow,
      peer_id: msg.from,
    });
  }

  private _handle_unbind(
    msg: Extract<TorrentControlMessage, { type: "ANNOUNCE_UNBIND" }>,
  ) {
    // ensure peer entry has bb map
    const peer = this.connected_peers.get(msg.from);
    if (peer && !peer.bb) peer.bb = new Map();
    if (!peer?.bb) return;

    const seeder_key: TorrentSeederBindingObj = {
      id: msg.seeder.id,
      name: msg.seeder.name,
    };
    let furrow_set = peer.bb.get(this.utils.serialize_binding(seeder_key));

    if (furrow_set && msg.furrow)
      if (msg.furrow?.id && msg.furrow?.name) {
        const furrow_key: TorrentFurrowBindingObj = {
          id: msg.furrow.id,
          name: msg.furrow.name,
          routing_key: msg.furrow.routing_key ?? msg.from ?? "",
        };
        // Remove furrow
        furrow_set?.delete(this.utils.serialize_binding(furrow_key));
      }

    if (!msg.furrow)
      // Remove seeder
      peer.bb.delete(this.utils.serialize_binding(seeder_key));

    this.emit("peer_unbind", {
      seeder: msg.seeder,
      furrow: msg.furrow,
      peer_id: msg.from,
    });
  }

  private _handle_receive(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    this._forward_msg(msg);
    // Local routing: accept message if routing_key matches this.identifier or empty
    const routing_key = msg.message?.properties?.routing_key ?? "";

    if (!routing_key || routing_key === this.identifier)
      this.emit("message_receive", msg);

    // Additionally, match against local broker_bindings (furrow-level routing)
    // broker bindings routing (furrow-level)
    for (const [seeder_entry, furrow_set] of this.broker_bindings) {
      const [seeder_id] = seeder_entry;

      // match seeder?
      if (msg.seeder.id !== seeder_id) continue;

      // if no furrow specified in control: deliver to all local furrows
      if (!msg.furrow) {
        for (const [furrow_id, furrow_name, furrow_rkey] of furrow_set) {
          if (!furrow_rkey || furrow_rkey === routing_key) {
            const tmsg = new TorrentMessage(msg.message?.body ?? null);
            tmsg.properties = msg.message?.properties ?? {};
            this.emit("message_receive", {
              ...msg,
              furrow: {
                id: furrow_id,
                name: furrow_name,
                routing_key: furrow_rkey,
              },
            });
          }
        }
        continue;
      }

      // if the PUBLISH specifies a furrow, match routing
      const { id: f_id } = msg.furrow;

      for (const [local_f_id, , local_rkey] of furrow_set) {
        // must match furrow id
        if (local_f_id !== f_id) continue;

        // routing_key must be empty or match
        if (!local_rkey || !routing_key || local_rkey === routing_key) {
          const tmsg = new TorrentMessage(msg.message?.body ?? null);
          tmsg.properties = msg.message?.properties ?? {};
          this.emit("message_receive", msg);
        }
      }
    }
  }

  private async _handle_submit(
    msg: Extract<TorrentControlMessage, { type: "SUBMIT" }>,
  ) {
    const { seeder: found_seeder, furrow: found_furrow } = this._search_hosted(
      msg.seeder,
      msg?.furrow,
    );

    if (!found_seeder) return;

    const seeder = this.seeders.find((s) => s.identifier === found_seeder.id);
    if (!seeder) return;

    const furrow = seeder.furrows.find(
      (f) => f.identifier === found_furrow?.id,
    );
    if (msg.furrow && !furrow) return;

    const encrypted_message = new TorrentMessage(msg?.message?.body || null);
    const encrypted_message_body = TorrentUtils.to_array_buffer(
      encrypted_message.body,
    );

    const message_signer = furrow ?? seeder;
    if (message_signer.get_mode() === "shadow") return;

    const signature = await message_signer.identity.sign(
      encrypted_message_body,
    );
    const control: Omit<
      Extract<TorrentControlMessage, { type: "PUBLISH" }>,
      "artifacts" | "control_id"
    > = {
      from: msg.from,
      type: "PUBLISH",
      seeder: {
        id: seeder.identifier,
        name: seeder.name,
        pub_key: seeder.pub_key,
      },
      ...(furrow
        ? {
            furrow: {
              id: furrow.identifier,
              name: furrow.name,
              pub_key: furrow.pub_key,
            },
          }
        : {}),
      message: {
        ...msg?.message,
        artifacts: {
          mac: msg?.message?.artifacts.mac || "",
          pub_key: message_signer.pub_key,
          signature: TorrentUtils.to_base64_url(signature),
          timestamp: Date.now(),
        },
      },
    };

    const artifacted_control = await this._add_message_artifacts(control);
    const _control = artifacted_control as Extract<
      TorrentControlMessage,
      { type: "PUBLISH" }
    >;

    // send to ourselves???
    this._handle_receive(_control);
    this._forward_msg(_control);
  }

  private _handle_find(msg: Extract<TorrentControlMessage, { type: "FIND" }>) {
    const { seeder, furrow } = this._search_hosted(msg.seeder, msg?.furrow);

    // if there is a match for the seeder (and furrow if specified)
    // send FOUND back, otherwise NOT_FOUND
    if (
      furrow ? seeder && furrow?.mode === "master" : seeder?.mode === "master"
    ) {
      const fnd_msg: Omit<
        Extract<TorrentControlMessage, { type: "FOUND" }>,
        "artifacts" | "control_id"
      > = {
        type: "FOUND",
        from: this.identifier,
        to: msg.from,
        seeder,
        furrow,
      };

      this._broadcast_control(fnd_msg);
    } else {
      const not_fnd_msg: Omit<
        Extract<TorrentControlMessage, { type: "NOT_FOUND" }>,
        "artifacts" | "control_id"
      > = {
        type: "NOT_FOUND",
        from: this.identifier,
        to: msg.from,
        seeder: msg.seeder,
        furrow: msg?.furrow,
      };

      this._broadcast_control(not_fnd_msg);
    }
  }

  private async _handle_found(
    msg: Extract<TorrentControlMessage, { type: "FOUND" }>,
  ) {
    const { seeder, furrow } = msg;

    this.emit("found", {
      seeder,
      furrow,
      peer_id: msg.from,
    });

    await this._handle_swarm_key_refresh({ ...msg, type: "SWARM_KEY_REFRESH" });
  }

  private async _handle_eph_offer(
    msg: Extract<TorrentControlMessage, { type: "EPH_KEY_OFFER" }>,
  ) {
    const { seeder: found_seeder, furrow: found_furrow } = this._search_hosted(
      msg.seeder,
      msg?.furrow,
    );

    const seeder = this.seeders.find((s) => s.identifier === msg.seeder.id);
    if (!found_seeder || !seeder) return;
    if (!seeder.identity) return;

    if (!found_furrow)
      await this._execute_eph_exchange(
        seeder.identity,
        seeder.get_swarm_key(),
        msg,
      );

    // Send ephemeral offer for furrow if applicable
    if (!found_furrow || !msg.furrow) return;
    const furrow_msg = msg.furrow;
    const furrow = seeder.furrows.find((f) => f.identifier === furrow_msg.id);
    if (furrow)
      await this._execute_eph_exchange(
        furrow.identity,
        furrow.get_swarm_key(),
        msg,
      );
  }

  private async _handle_eph_exchange(
    msg: Extract<TorrentControlMessage, { type: "EPH_KEY_EXCHANGE" }>,
  ) {
    const identity_pub_key = await TorrentIdentity.jwk_to_crypto(
      msg.key_sig.identity_pub_key,
    );
    const valid = await TorrentIdentity.verify(
      TorrentUtils.from_base64_url(msg.key_sig.eph_pub_key),
      TorrentUtils.from_base64_url(msg.key_sig.signature),
      identity_pub_key,
    );
    const _eph = this.eph_aes_keys.get(
      msg.furrow ? msg.furrow.id : msg.seeder.id,
    );

    if (!valid) return;
    if (_eph?.ephemeral) {
      const aes_salt = TorrentUtils.from_base64_url(msg.encrypted.aes_salt);

      const aes_key = await _eph.ephemeral.create_aes_key(
        TorrentUtils.from_base64_url(msg.eph_pub_key),
        aes_salt,
      );
      const swarm_key = await TorrentUtils.decrypt(
        TorrentUtils.from_base64_url(msg.encrypted.swarm_key),
        aes_key.aes_key,
      );

      // we r no longer "master" no don't list as hosted
      this._remove_from_hosted(msg.seeder.name, msg.furrow?.name);

      // do something with swarm_key
      this.emit("eph_exchange_complete", {
        seeder: {
          ...msg.seeder,
          // dont add swarm_key as it is for the furrow
          ...(!msg.furrow
            ? {
                swarm_key,
              }
            : {}),
        },
        ...(msg.furrow ? { furrow: { ...msg.furrow, swarm_key } } : {}),
        peer_id: msg.from,
      });

      this.eph_aes_keys.delete(msg.furrow ? msg.furrow.id : msg.seeder.id);
    }
  }

  private async _handle_swarm_key_refresh(
    msg: Extract<TorrentControlMessage, { type: "SWARM_KEY_REFRESH" }>,
  ) {
    const { seeder, furrow } = msg;

    const eph_key = await TorrentEphemeral.create();
    const eph_pub_key_array_buffer = await eph_key.export_public();
    this.eph_aes_keys.set(furrow ? furrow.id : seeder.id, {
      ephemeral: eph_key,
    });

    this.emit("eph_exchange_init", furrow ? { ...furrow } : { ...seeder });

    const eph_offer_msg: Omit<
      Extract<TorrentControlMessage, { type: "EPH_KEY_OFFER" }>,
      "artifacts" | "control_id"
    > = {
      type: "EPH_KEY_OFFER",
      from: this.identifier,
      to: msg.from,
      seeder,
      furrow,
      eph_pub_key: TorrentUtils.to_base64_url(eph_pub_key_array_buffer),
    };

    this._broadcast_control(eph_offer_msg);
  }

  private async _handle_pulse(
    msg: Extract<TorrentControlMessage, { type: "PULSE" }>,
  ) {
    const { seeder, furrow } = msg;

    this.emit("seeder_pulse", { id: seeder.id, name: seeder.name });
    if (furrow) this.emit("furrow_pulse", { id: furrow.id, name: furrow.name });
  }

  private _handle_lru_store(
    msg: Extract<TorrentControlMessage, { type: "LRU_STORE" }>,
  ) {
    if (msg.to !== this.identifier) return;
    const { message: control } = msg;
    if (this.data_store.has(control.control_id)) return;
    this.store(control);
  }

  private _forward_msg_naive(control: TorrentControlMessage) {
    if (this.data_store.has(control.control_id)) return;

    for (const [, entry] of this.connected_peers) {
      if (entry.dc && entry.dc.readyState === "open") {
        try {
          entry.dc.send(JSON.stringify(control));
        } catch (e) {
          console.warn("failed to broadcast control to peer", e);
        }
      }
    }
  }

  private _forward_msg(
    control: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    if (this.data_store.has(control.control_id)) return;
    this.store(control);

    const best_candidates = this._calculate_candidates();

    for (const { peer_id } of best_candidates) {
      const entry = this.connected_peers.get(peer_id);
      if (!entry?.dc) continue;
      if (entry.dc && entry.dc.readyState === "open") {
        const new_control: TorrentControlMessage = {
          ...control,
          ...(control?.message
            ? {
                message: {
                  ...control.message,
                  properties: {
                    ...control.message?.properties,
                    headers: {
                      ...control.message?.properties?.headers,
                      hop_count:
                        (control.message?.properties?.headers?.hop_count ?? 0) +
                        1,
                    },
                  },
                },
              }
            : {}),
        };

        try {
          entry.dc.send(JSON.stringify(new_control));
        } catch (e) {
          console.warn("failed to broadcast control to peer", e);
        }
      }
    }
  }

  // TODO: A* algorithm for advanced routing
  // get the stats for the peer connections
  // choose the best peer based on latency, bandwidth, etc.
  // It seems that A* makes no sense for this.
  // Will be pivoting to Weighted K-Best Forwarding (W-KBF)
  // Which is a more efficient version of flodding.
  private _calculate_candidates(): { peer_id: string; ema: number }[] {
    // NOTE: stop assaulting this fucking code pls
    // I DON'T THINK SO BUDDY
    const active_peers = Array.from(this.connected_peers.entries()).filter(
      ([, entry]) => entry?.dc && entry.dc.readyState === "open",
    );
    const candidates: Array<{ peer_id: string; ema: number }> =
      active_peers.map(([peer_id, entry]) => ({
        peer_id,
        ema: entry?.stats?.distance ?? Infinity,
      }));

    if (candidates.length === 0) return [];

    const k_max = Math.ceil(Math.sqrt(candidates.length));
    const k = Math.max(1, Math.min(k_max, candidates.length)); // ensure the value of k is at least 1

    const known_stats = candidates.filter((c) => c.ema !== Infinity);
    const unknown_stats = candidates.filter((c) => c.ema === Infinity);

    if (known_stats.length > 0) {
      // sort by EMA ie lowest distance first
      known_stats.sort((a, b) => a.ema - b.ema);

      if (known_stats.length >= k) return known_stats.slice(0, k);
    }

    // if not enough known stats, mix an random unknown peers
    const shuffled_unknown = unknown_stats.sort(() => Math.random() - 0.5);
    const combined = [...known_stats, ...shuffled_unknown];
    return combined.slice(0, k);
  }

  // TODO: implement load balancing for sharing seeders
  // multiple peers hosting the same seeder but only part of it e.g. one furrow
  // private async _load_balance_control() {}
  // 3/4/2026: what was that guy thinking?

  private async _add_message_artifacts(
    control: Omit<TorrentControlMessage, "control_id" | "artifacts">,
  ) {
    // "Wash" the message to remove undefineds and normalize types
    const cleaned_control = JSON.parse(JSON.stringify(control));

    if (
      control.type !== "ANNOUNCE_BIND" &&
      control.type !== "ANNOUNCE_UNBIND" &&
      control.type !== "LRU_STORE"
    ) {
      const msg_bytes = TorrentUtils.to_array_buffer(cleaned_control);
      const signature = await this.identity.sign(msg_bytes);
      const pub_key = await this.identity.export_public_jwk();

      return {
        ...cleaned_control,
        control_id: TorrentUtils.random_string(),
        artifacts: {
          pub_key,
          signature: TorrentUtils.to_base64_url(signature),
          timestamp: Date.now(),
        },
      } as TorrentControlMessage;
    }

    return {
      ...cleaned_control,
      control_id: TorrentUtils.random_string(),
    } as TorrentControlMessage;
  }

  private _search_hosted(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    let hosted_seeder: TorrentHostedObj = undefined as any;
    let hosted_furrow: TorrentHostedObj = undefined as any;

    for (const [seeder_entry, furrow_set] of this.hosted) {
      const real_seeder = this.utils.deserialize_hosted(seeder_entry);

      if (real_seeder.name !== seeder.name) continue;
      hosted_seeder = real_seeder;

      if (furrow) {
        const req_furrow_name = furrow.name;

        for (const furrow_entry of furrow_set) {
          const real_furrow = this.utils.deserialize_hosted(furrow_entry);
          if (real_furrow.name !== req_furrow_name) continue;
          hosted_furrow = real_furrow;
        }
      }
    }

    return { seeder: hosted_seeder, furrow: hosted_furrow };
  }

  private _add_to_hosted(seeder: TorrentHostedObj, furrow?: TorrentHostedObj) {
    if (seeder.mode === "shadow" && !furrow) return;

    const { seeder: found_seeder, furrow: found_furrow } = this._search_hosted(
      seeder,
      furrow,
    );
    const new_serialized_seeder = this.utils.serialize_hosted(seeder);

    if (found_seeder) {
      const old_serialized_seeder = this.utils.serialize_hosted(found_seeder);
      if (old_serialized_seeder !== new_serialized_seeder) {
        const existing_set = this.hosted.get(old_serialized_seeder);
        this.hosted.delete(old_serialized_seeder);
        this.hosted.set(new_serialized_seeder, existing_set ?? new Set());
      }
    }

    let s_value = this.hosted.get(new_serialized_seeder);
    if (!s_value) {
      s_value = new Set();
      this.hosted.set(new_serialized_seeder, s_value);
    }

    if (furrow && furrow.mode === "master") {
      const serialized_furrow = this.utils.serialize_hosted(furrow);
      if (found_furrow) {
        const old_serialized_furrow = this.utils.serialize_hosted(found_furrow);
        // remove old version - it's an overwrite
        s_value.delete(old_serialized_furrow);
      }
      s_value.add(serialized_furrow);
    }
  }

  // Remove a furrow from a seeder, remove seeder if no furrows remain
  private _remove_from_hosted(seeder_search: string, furrow_search?: string) {
    const trimmed_seeder = seeder_search.trim();
    const trimmed_furrow = furrow_search?.trim();

    for (const [seeder_key, furrow_set] of this.hosted) {
      const seeder_obj = this.utils.deserialize_hosted(seeder_key);

      if (
        seeder_obj.name.trim() === trimmed_seeder ||
        seeder_obj.id.trim() === trimmed_seeder
      ) {
        if (trimmed_furrow)
          for (const furrow_key of furrow_set) {
            const furrow_obj = this.utils.deserialize_hosted(furrow_key);

            if (
              furrow_obj.name.trim() === trimmed_furrow ||
              furrow_obj.id.trim() === trimmed_furrow
            )
              furrow_set.delete(furrow_key);
          }
        else this.hosted.delete(seeder_key);
      }
    }
  }

  private _search_bound(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    let bound_seeder: TorrentSeederBindingObj = undefined as any;
    let bound_furrow: TorrentFurrowBindingObj = undefined as any;

    for (const [seeder_key, furrow_set] of this.broker_bindings) {
      const real_seeder = this.utils.deserialize_binding(seeder_key);

      if (real_seeder.name !== seeder.name) continue;
      bound_seeder = real_seeder;

      if (furrow) {
        const req_furrow_name = furrow.name;

        for (const furrow_key of furrow_set) {
          const real_furrow = this.utils.deserialize_binding(furrow_key);
          if (real_furrow.name !== req_furrow_name) continue;
          bound_furrow = real_furrow;
        }
      }
    }

    return { seeder: bound_seeder, furrow: bound_furrow };
  }

  private _bind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: TorrentSeederBindingObj = {
      id: seeder.id,
      name: seeder.name,
    };

    const new_serialized_seeder = this.utils.serialize_binding(seeder_key);
    const { seeder: found_seeder, furrow: found_furrow } = this._search_bound(
      seeder,
      furrow,
    );

    if (found_seeder) {
      const old_serialized_seeder = this.utils.serialize_binding(found_seeder);
      if (old_serialized_seeder !== new_serialized_seeder) {
        const existing_set = this.broker_bindings.get(old_serialized_seeder);
        this.broker_bindings.delete(old_serialized_seeder);
        this.broker_bindings.set(
          new_serialized_seeder,
          existing_set ?? new Set(),
        );
      }
    }

    let s_value = this.broker_bindings.get(new_serialized_seeder);
    if (!s_value) {
      s_value = new Set();
      this.broker_bindings.set(new_serialized_seeder, s_value);
    }

    if (!furrow) return;

    const furrow_key: TorrentFurrowBindingObj = {
      id: furrow.id,
      name: furrow.name,
      routing_key: furrow.routing_key ?? this.identifier,
    };
    const serialized_furrow = this.utils.serialize_binding(furrow_key);
    if (found_furrow) {
      const old_serialized_furrow = this.utils.serialize_binding(found_furrow);
      // remove old version - it's an overwrite
      s_value.delete(old_serialized_furrow);
    }

    s_value.add(serialized_furrow);
  }

  private _unbind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow & { public_key?: JsonWebKey },
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: TorrentSeederBindingObj = {
      id: seeder.id,
      name: seeder.name,
    };
    let furrow_set = this.broker_bindings.get(
      this.utils.serialize_binding(seeder_key),
    );

    if (!furrow_set && furrow) return;
    if (furrow) {
      const furrow_key: TorrentFurrowBindingObj = {
        id: furrow.id,
        name: furrow.name,
        routing_key: furrow.routing_key ?? this.identifier,
      };
      furrow_set?.delete(this.utils.serialize_binding(furrow_key));
      return;
    }
    this.broker_bindings.delete(this.utils.serialize_binding(seeder_key));
  }

  private async _execute_eph_exchange(
    identity: TorrentIdentity,
    swarm_key: ArrayBuffer,
    msg: Extract<TorrentControlMessage, { type: "EPH_KEY_OFFER" }>,
  ) {
    const eph_key = await TorrentEphemeral.create();
    const signature = await identity.sign(
      TorrentUtils.from_base64_url(msg.eph_pub_key),
    );
    const identity_pub_key = await identity.export_public_jwk();
    const eph_pub_key = await eph_key.export_public();
    const aes_salt = TorrentUtils.generate_salt();

    const aes_key_obj = await eph_key.create_aes_key(
      TorrentUtils.from_base64_url(msg.eph_pub_key),
      aes_salt,
    );
    const encrypted_swarm_key_array_buffer = await TorrentUtils.encrypt(
      swarm_key,
      aes_key_obj.aes_key,
    );

    // send swarm key
    const eph_offer_msg: Omit<
      Extract<TorrentControlMessage, { type: "EPH_KEY_EXCHANGE" }>,
      "artifacts" | "control_id"
    > = {
      type: "EPH_KEY_EXCHANGE",
      from: this.identifier,
      to: msg.from,
      seeder: msg.seeder,
      furrow: msg.furrow,
      eph_pub_key: TorrentUtils.to_base64_url(eph_pub_key),
      key_sig: {
        eph_pub_key: msg.eph_pub_key,
        signature: TorrentUtils.to_base64_url(signature),
        identity_pub_key,
      },
      encrypted: {
        swarm_key: TorrentUtils.to_base64_url(encrypted_swarm_key_array_buffer),
        aes_salt: TorrentUtils.to_base64_url(aes_salt),
      },
    };

    this._broadcast_control(eph_offer_msg);
  }
}
