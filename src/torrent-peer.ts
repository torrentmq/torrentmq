import { TorrentDHTNode } from "./torrent-dht";
import { TorrentEphemeral } from "./torrent-ephemeral";
import { TorrentError } from "./torrent-error";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";
import { TorrentSeeder } from "./torrent-seeder";
import {
  TorrentBrokerHost,
  TorrentControlMessage,
  TorrentPeerHostingSize,
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

  readonly max_hosting_size: TorrentPeerHostingSize = {
    number_of_seeders: 4,
    number_of_furrows_per_seeder: 8,
  };

  constructor(options?: {
    ws_url?: string;
    peer_max_hosting_size?: TorrentPeerHostingSize;
    min_peer_cluster_size?: number;
    max_peer_cluster_size?: number;
    status_frequency?: number;
    partion_heal_interval?: number;
    lru_size?: number;
  }) {
    const { peer_max_hosting_size, ...rest } = options || {};
    super(rest);

    if (
      peer_max_hosting_size &&
      peer_max_hosting_size?.number_of_furrows_per_seeder > 0 &&
      peer_max_hosting_size?.number_of_seeders > 0
    )
      this.max_hosting_size = peer_max_hosting_size;

    // Handlers from dht node
    this.on<{ parsed: TorrentControlMessage; remote_id: string }>(
      "control_message",
      (data) => {
        this._handle_control_message(data.parsed, data.remote_id);
      },
    );

    this.on<{ peer_id: string }>(
      "peer_connected",
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
      ...(cert ? { cert } : { pub_key }),
      ...(options && Object.keys(options).length > 0
        ? { properties: { ...options } }
        : {}),
    });

    seeder.on<{
      seeder: TorrentHostedObj;
      furrow: TorrentHostedObj;
    }>("created_furrow", (data) => {
      if (this.hosted.has(this.utils.serialize_hosted(data.seeder)))
        this._add_to_hosted(data.seeder, data.furrow);
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

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_BIND",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this.emit("bind", { seeder, furrow });
    this._broadcast_control(control);
  }

  unregister_remote_binding(
    seeder: TorrentControlSeeder,
    furrow: TorrentControlBindFurrow,
  ) {
    this._unbind_seeder_or_furrow(seeder, furrow);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_UNBIND",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this.emit("unbind", { seeder, furrow });
    this._broadcast_control(control);
  }

  //  NOTE: All control traffic to DCs only. WebSocket signaling is used only for HELO/OFFER/ANSWER/ICE.
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
      case "EPH_KEY_EXCHANGE": {
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

    console.log({
      msg_body,
      msg_buffer: msg_bytes,
      sig: artifacts.signature,
    });

    const valid = await TorrentIdentity.verify(
      msg_bytes,
      TorrentUtils.from_base64_url(artifacts.signature),
      artifacts.pub_key,
    );
    if (!valid) return;

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
        this._handle_found(control);
        break;
      }

      case "NOT_FOUND": {
        this.emit("not_found", { seeder: control.seeder });
        break;
      }

      case "EPH_KEY_OFFER": {
        this._handle_eph_offer(control);
        break;
      }

      case "EPH_KEY_EXCHANGE": {
        this._handle_eph_exchange(control);
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
    // ignore if message from self
    if (msg.from === this.identifier) return;

    // already processed, skip entirely
    if (this.data_store.has(msg.control_id)) return;
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
    if (msg.from === this.identifier) return;
    // already processed, skip entirely
    if (this.data_store.has(msg.control_id)) return;

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
    if (!message_signer.is_root) return;

    message_signer.identity.sign(encrypted_message_body).then((signature) => {
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

      this._add_message_artifacts(control).then((artifacted_control) => {
        const _control = artifacted_control as Extract<
          TorrentControlMessage,
          { type: "PUBLISH" }
        >;

        // send to ourselves???
        this._handle_receive(_control);
        this._forward_msg(_control);
      });
    });
  }

  private _handle_find(msg: Extract<TorrentControlMessage, { type: "FIND" }>) {
    const { seeder, furrow } = this._search_hosted(msg.seeder, msg?.furrow);

    // if there is a match for the seeder (and furrow if specified)
    // send FOUND back, otherwise NOT_FOUND
    if (furrow ? seeder && furrow : seeder) {
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

  private _handle_found(
    msg: Extract<TorrentControlMessage, { type: "FOUND" }>,
  ) {
    const { seeder, furrow } = msg;

    this.emit("found", {
      seeder,
      furrow,
      peer_id: msg.from,
    });

    TorrentEphemeral.create().then((eph_key) => {
      this.eph_aes_keys.set(furrow ? furrow.id : seeder.id, {
        ephemeral: eph_key,
      });

      eph_key.export_public().then((eph_pub_key_array_buffer) => {
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
      });
    });
  }

  private _handle_eph_offer(
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
      this._execute_eph_exchange(seeder.identity, seeder.get_swarm_key(), msg);

    // Send ephemeral offer for furrow if applicable
    if (!found_furrow || !msg.furrow) return;
    const furrow_msg = msg.furrow;
    const furrow = seeder.furrows.find((f) => f.identifier === furrow_msg.id);
    if (furrow)
      this._execute_eph_exchange(furrow.identity, furrow.get_swarm_key(), msg);
  }

  private _handle_eph_exchange(
    msg: Extract<TorrentControlMessage, { type: "EPH_KEY_EXCHANGE" }>,
  ) {
    TorrentIdentity.jwk_to_crypto(msg.key_sig.identity_pub_key).then(
      (identity_pub_key) => {
        TorrentIdentity.verify(
          TorrentUtils.from_base64_url(msg.key_sig.eph_pub_key),
          TorrentUtils.from_base64_url(msg.key_sig.signature),
          identity_pub_key,
        ).then((valid) => {
          const _eph = this.eph_aes_keys.get(
            msg.furrow ? msg.furrow.id : msg.seeder.id,
          );
          if (valid) {
            if (_eph?.ephemeral) {
              const aes_salt = TorrentUtils.from_base64_url(
                msg.encrypted.aes_salt,
              );

              _eph.ephemeral
                .create_aes_key(
                  TorrentUtils.from_base64_url(msg.eph_pub_key),
                  aes_salt,
                )
                .then((aes_key) => {
                  TorrentUtils.decrypt(
                    TorrentUtils.from_base64_url(msg.encrypted.swarm_key),
                    aes_key.aes_key,
                  ).then((swarm_key) => {
                    // do something with swarm_key
                    this._remove_from_hosted(msg.seeder.name, msg.furrow?.name);

                    this.emit("swarm_key_exchanged", {
                      seeder: {
                        ...msg.seeder,
                        // dont add swarm_key as it is for the furrow
                        ...(!msg.furrow
                          ? {
                              swarm_key,
                            }
                          : {}),
                      },
                      ...(msg.furrow
                        ? { furrow: { ...msg.furrow, swarm_key } }
                        : {}),
                      peer_id: msg.from,
                    });

                    this.eph_aes_keys.delete(
                      msg.furrow ? msg.furrow.id : msg.seeder.id,
                    );
                  });
                });
            }
          }
        });
      },
    );
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

  private _split_candidates(
    candidates: { peer_id: string; ema: number }[],
    k: number,
  ) {
    const best = candidates.slice(0, k);
    return best;
  }

  // TODO: A* algorithm for advanced routing
  // get the stats for the peer connections
  // choose the best peer based on latency, bandwidth, etc.
  // It seems that A* makes no sense for this.
  // Will be pivoting to Weighted K-Best Forwarding (W-KBF)
  // Which is a more efficient version of flodding.
  private _calculate_candidates(): { peer_id: string; ema: number }[] {
    const candidates: Array<{ peer_id: string; ema: number }> = Array.from(
      this.connected_peers.entries(),
    ).map(([peer_id, entry]) => ({
      peer_id,
      ema: entry?.stats?.distance ?? Infinity,
    }));

    const k_max = Math.ceil(Math.sqrt(candidates.length));
    const k = Math.min(k_max, candidates.length);

    candidates.sort((a, b) => a.ema - b.ema);
    return this._split_candidates(candidates, k);
  }

  // TODO: implement load balancing for sharing seeders
  // multiple peers hosting the same seeder but only part of it e.g. one furrow
  // private async _load_balance_control() {}
  //
  // 3/4/2026: what was that guy thinking?

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

  private async _add_message_artifacts(
    control: Omit<TorrentControlMessage, "control_id" | "artifacts">,
  ) {
    // "Wash" the message to remove undefineds and normalize types
    const cleaned_control = JSON.parse(JSON.stringify(control));

    if (
      control.type !== "ANNOUNCE_BIND" &&
      control.type !== "ANNOUNCE_UNBIND"
    ) {
      const msg_bytes = TorrentUtils.to_array_buffer(cleaned_control);
      const signature = await this.identity.sign(msg_bytes);
      const pub_key = await this.identity.export_public_jwk();

      console.log({
        msg_body: cleaned_control,
        msg_buffer: msg_bytes,
        sig: TorrentUtils.to_base64_url(signature),
      });

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

  private _add_to_hosted(seeder: TorrentHostedObj, furrow?: TorrentHostedObj) {
    const serialized_seeder = this.utils.serialize_hosted(seeder);
    let s_value = this.hosted.get(serialized_seeder);

    if (!s_value) {
      s_value = new Set();
      this.hosted.set(serialized_seeder, s_value);
    }

    if (furrow) {
      const serialized_furrow = this.utils.serialize_hosted(furrow);

      if (!s_value.has(serialized_furrow)) s_value.add(serialized_furrow);
    }
  }

  // Remove a furrow from a seeder, remove seeder if no furrows remain
  private _remove_from_hosted(seeder: string, furrow?: string) {
    for (const [seeder_item, furrow_set] of this.hosted) {
      const seeder_deserialized = this.utils.deserialize_hosted(seeder_item);

      if (
        seeder_deserialized.name.trim() === seeder.trim() ||
        seeder_deserialized.id.trim() === seeder.trim()
      ) {
        if (furrow)
          for (const furrow_item of furrow_set) {
            const furrow_deserialized =
              this.utils.deserialize_hosted(furrow_item);

            if (
              furrow_deserialized.name.trim() === furrow.trim() ||
              furrow_deserialized.id.trim() === furrow.trim()
            )
              furrow_set.delete(furrow_item);
          }
        else this.hosted.delete(seeder_item);
      }
    }
  }

  private _bind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow & { public_key?: JsonWebKey },
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: TorrentSeederBindingObj = {
      id: seeder.id,
      name: seeder.name,
      pub_key: seeder.public_key,
    };
    let furrow_set = this.broker_bindings.get(
      this.utils.serialize_binding(seeder_key),
    );

    if (!furrow_set) {
      furrow_set = new Set();
      this.broker_bindings.set(
        this.utils.serialize_binding(seeder_key),
        furrow_set,
      );
    }

    if (furrow?.id && furrow?.name) {
      const furrow_key: TorrentFurrowBindingObj = {
        id: furrow.id,
        name: furrow.name,
        routing_key: furrow.routing_key ?? this.identifier,
      };
      furrow_set.add(this.utils.serialize_binding(furrow_key));
    }
  }

  private _unbind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow & { public_key?: JsonWebKey },
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: TorrentSeederBindingObj = {
      id: seeder.id,
      name: seeder.name,
      pub_key: seeder.public_key,
    };
    let furrow_set = this.broker_bindings.get(
      this.utils.serialize_binding(seeder_key),
    );

    if (!furrow_set && furrow) return;
    if (furrow?.id && furrow?.name) {
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

  private _execute_eph_exchange(
    identity: TorrentIdentity,
    swarm_key: ArrayBuffer,
    msg: Extract<TorrentControlMessage, { type: "EPH_KEY_OFFER" }>,
  ) {
    TorrentEphemeral.create().then((eph_key) => {
      identity
        .sign(TorrentUtils.from_base64_url(msg.eph_pub_key))
        .then((signature) => {
          identity.export_public_jwk().then((identity_pub_key) => {
            eph_key.export_public().then((eph_pub_key) => {
              const aes_salt = TorrentUtils.generate_salt();

              eph_key
                .create_aes_key(
                  TorrentUtils.from_base64_url(msg.eph_pub_key),
                  aes_salt,
                )
                .then((aes_key) => {
                  // send swarm key
                  TorrentUtils.encrypt(swarm_key, aes_key.aes_key).then(
                    (encrypted_swarm_key_array_buffer) => {
                      const eph_offer_msg: Omit<
                        Extract<
                          TorrentControlMessage,
                          { type: "EPH_KEY_EXCHANGE" }
                        >,
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
                          swarm_key: TorrentUtils.to_base64_url(
                            encrypted_swarm_key_array_buffer,
                          ),
                          aes_salt: TorrentUtils.to_base64_url(aes_salt),
                        },
                      };

                      this._broadcast_control(eph_offer_msg);
                    },
                  );
                });
            });
          });
        });
    });
  }
}
