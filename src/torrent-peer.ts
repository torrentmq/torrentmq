import { TorrentUtils } from "./torrent-utils";
import { TorrentError } from "./torrent-error";
import { TorrentDHTNode } from "./torrent-dht";
import { TorrentMessage } from "./torrent-message";
import {
  TorrentControlMessage,
  TorrentMessageObject,
  TorrentControlSeederOrFurrow,
  TorrentControlBindFurrow,
  TorrentSeederParams,
  TorrentBrokerHost,
  TorrentFurrowHostedObj,
  TorrentSeederHostedObj,
  TorrentSeederBindingObj,
  TorrentFurrowBindingObj,
} from "./torrent-types";
import { TorrentSeederProxy } from "./torrent-proxies/torrent-seeder-proxy";

export class TorrentPeer extends TorrentDHTNode {
  // the hosted seeders and or furrows [seeeder_name] -> [furrow_name][]
  private hosted: TorrentBrokerHost = new Map();
  private seeders: TorrentSeederProxy[] = [];
  private is_connected: boolean = false;

  readonly max_hosting_size: number = 8;

  constructor(options?: {
    ws_url?: string;
    peer_max_hosting_size?: number;
    min_peer_cluster_size?: number;
    max_peer_cluster_size?: number;
    status_frequency?: number;
    partion_heal_interval?: number;
    lru_size?: number;
  }) {
    const { peer_max_hosting_size, ...rest } = options || {};
    super(rest);

    if (peer_max_hosting_size && peer_max_hosting_size > 0)
      this.max_hosting_size = peer_max_hosting_size;

    this.on<{ parsed: TorrentControlMessage; remote_id: string }>(
      "CONTROL_MESSAGE",
      (data) => {
        this._handle_control_message(data.parsed, data.remote_id);
      },
    );

    this.on<{ peer_id: string }>(
      "PEER_CONNECTED",
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

    const seeder = await TorrentSeederProxy.create(this, name, options);
    this.seeders.push(seeder);

    this._add_to_hosted({
      id: seeder.identifier,
      seeder_name: seeder.name,
      public_key: seeder.public_key,
      ...(options && Object.keys(options).length > 0
        ? { properties: { ...options } }
        : {}),
    });

    seeder.on<{
      seeder: TorrentSeederHostedObj;
      furrow: TorrentFurrowHostedObj;
    }>("CREATED_FURROW", (data) => {
      if (this.hosted.has(this.utils.serialize(data.seeder)))
        this._add_to_hosted(data.seeder, data.furrow);
    });

    return seeder;
  }

  // For Seeders/ Furrows

  register_remote_binding(
    seeder: TorrentControlSeederOrFurrow & { public_key?: JsonWebKey },
    furrow?: TorrentControlBindFurrow,
  ) {
    this._bind_seeder_or_furrow(seeder, furrow);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_BIND",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this.emit("BIND", { seeder, furrow });
    this._broadcast_control(control);
  }

  unregister_remote_binding(
    seeder: TorrentControlSeederOrFurrow & { public_key?: JsonWebKey },
    furrow?: TorrentControlBindFurrow,
  ) {
    this._unbind_seeder_or_furrow(seeder, furrow);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_UNBIND",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this.emit("UNBIND", { seeder, furrow });
    this._broadcast_control(control);
  }

  publish(msg: {
    seeder: TorrentControlSeederOrFurrow & { public_key: JsonWebKey };
    furrow?: TorrentControlSeederOrFurrow;
    message?: TorrentMessage;
    signature: string;
  }) {
    const publish_msg: TorrentMessageObject = {
      body: msg.message?.body,
      properties: msg.message?.properties,
    };

    const control: TorrentControlMessage = {
      type: "PUBLISH",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      seeder: msg.seeder,
      furrow: msg?.furrow,
      message: publish_msg,
      artifacts: {
        signature: msg.signature,
        timestamp: Date.now(),
      },
    };

    // send to all connected peers via datachannels if available
    this._handle_publish(control);
  }

  submit(msg: {
    seeder: TorrentControlSeederOrFurrow;
    furrow?: TorrentControlSeederOrFurrow;
    message?: TorrentMessage;
  }) {
    const publish_msg: TorrentMessageObject = {
      body: msg.message?.body,
      properties: msg.message?.properties,
    };

    const control: TorrentControlMessage = {
      type: "SUBMIT",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      seeder: msg.seeder,
      furrow: msg?.furrow,
      message: publish_msg,
    };

    // send to peer that hosts the seeder/furrow
    // hosted seeder will sign and re-broadcast the message
    // just return a publish
    this._broadcast_control(control);
    this.emit("PUBLISH", msg);
  }

  find(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    const control: TorrentControlMessage = {
      type: "FIND",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this._broadcast_control(control);
  }

  private _add_to_hosted(
    seeder: TorrentSeederHostedObj,
    furrow?: TorrentFurrowHostedObj,
  ) {
    let s_value = this.hosted.get(this.utils.serialize(seeder));

    if (!s_value) {
      s_value = new Set();
      this.hosted.set(this.utils.serialize(seeder), s_value);
    }

    if (furrow) {
      const serialized_furrow =
        this.utils.serialize<TorrentFurrowHostedObj>(furrow);

      if (!s_value.has(serialized_furrow)) s_value.add(serialized_furrow);
    }
  }

  // Remove a furrow from a seeder, remove seeder if no furrows remain
  private _remove_from_hosted(seeder: string, furrow?: string) {
    for (const [seeder_item, furrow_set] of this.hosted) {
      const seeder_deserialized = this.utils.deserialize(seeder_item);

      if (
        seeder_deserialized.seeder_name.trim() === seeder.trim() ||
        seeder_deserialized.id.trim() === seeder.trim()
      ) {
        if (furrow)
          for (const furrow_item of furrow_set) {
            const furrow_deserialized = this.utils.deserialize(furrow_item);

            if (
              furrow_deserialized.furrow_name.trim() === furrow.trim() ||
              furrow_deserialized.id.trim() === furrow.trim()
            )
              furrow_set.delete(furrow_item);
          }
        else this.hosted.delete(seeder_item);
      }
    }
  }

  // Move all control traffic to DCs only. WebSocket signaling is used only for HELO/OFFER/ANSWER/ICE.
  private _broadcast_control(
    control: TorrentControlMessage,
    to_peer_id?: string,
  ) {
    // if a target peer_id is given, send only to that peer (if open)
    if (to_peer_id) {
      const targeted = this.connected_peers.get(to_peer_id);
      if (targeted?.dc && targeted.dc.readyState === "open") {
        try {
          targeted.dc.send(JSON.stringify(control));
        } catch (e) {
          console.warn("failed to send control to target peer", e);
        }
      }
      return;
    }

    if (control.type !== "PUBLISH")
      // otherwise broadcast to all connected peers over DCs only
      for (const [, entry] of this.connected_peers) {
        if (entry.dc && entry.dc.readyState === "open") {
          try {
            entry.dc.send(JSON.stringify(control));
          } catch (e) {
            console.warn("failed to broadcast control to peer", e);
          }
        }
      }
    else
      // use the weighted k-best forwarding alg
      this._forward_msg(control).then();
  }

  private _handle_control_message(
    control: TorrentControlMessage,
    from_peer_id?: string,
  ) {
    // ensure peer entry has bb map
    const peer = this.connected_peers.get(from_peer_id ?? control.from);
    if (peer && !peer.bb) peer.bb = new Map();

    switch (control.type) {
      case "ANNOUNCE_BIND": {
        if (!peer?.bb) break;
        const seeder_key: TorrentSeederBindingObj = {
          seeder_id: control.seeder.id,
          name: control.seeder.name,
        };
        let furrow_set = peer.bb.get(this.utils.serialize(seeder_key));

        if (!furrow_set) {
          // If no furrows are bound to this seeder yet, create a new Set
          furrow_set = new Set();
          peer.bb.set(this.utils.serialize(seeder_key), furrow_set);
        }

        // If a furrow is provided, add the furrow to the set for this seeder
        if (control.furrow?.id && control.furrow?.name) {
          const furrow_key: TorrentFurrowBindingObj = {
            furrow_id: control.furrow.id,
            name: control.furrow.name,
            routing_key:
              control.furrow.routing_key ?? from_peer_id ?? control.from,
          };
          furrow_set.add(this.utils.serialize(furrow_key));
        }

        this.emit("PEER_BIND", {
          seeder: control.seeder,
          furrow: control.furrow,
          peer_id: from_peer_id,
        });
        break;
      }

      case "ANNOUNCE_UNBIND": {
        if (!peer?.bb) break;
        const seeder_key: TorrentSeederBindingObj = {
          seeder_id: control.seeder.id,
          name: control.seeder.name,
        };
        let furrow_set = peer.bb.get(this.utils.serialize(seeder_key));

        if (!furrow_set && control.furrow) break;
        if (control.furrow?.id && control.furrow?.name) {
          const furrow_key: TorrentFurrowBindingObj = {
            furrow_id: control.furrow.id,
            name: control.furrow.name,
            routing_key:
              control.furrow.routing_key ?? from_peer_id ?? control.from,
          };
          // Remove furrow
          furrow_set?.delete(this.utils.serialize(furrow_key));
        }
        if (!control.furrow) {
          // Remove seeder
          peer.bb.delete(this.utils.serialize(seeder_key));
        }

        this.emit("PEER_UNBIND", {
          seeder: control.seeder,
          furrow: control.furrow,
          peer_id: from_peer_id,
        });
        break;
      }

      case "SUBMIT": {
        this._handle_submit(control);
        break;
      }

      case "PUBLISH": {
        this._handle_receive(control);
        break;
      }

      case "ACK": {
        // TODO: ack handling (deliver to on_ack callbacks)
        this.emit("ACK", {
          message_id: control.message_id,
          peer_id: from_peer_id,
        });
        break;
      }

      case "FIND": {
        this._search_seeder_or_furrow(control);
        break;
      }

      case "FOUND": {
        this._handle_found(control);
        break;
      }

      case "NOT_FOUND": {
        this.emit("NOT_FOUND", { seeder: control.seeder });
        break;
      }
    }
  }

  private _handle_publish(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    // We broadcast a message to other peers and emit a PUBLISH event.
    // Broadcast to connected peers (DCs only)
    this._broadcast_control(msg);
    this.emit("PUBLISH", msg);
  }

  private async _handle_submit(
    msg: Extract<TorrentControlMessage, { type: "SUBMIT" }>,
  ) {
    if (msg.from === this.identifier) return;
    const seeder = this.seeders.find((s) => s.identifier === msg.seeder.id);

    if (!seeder) return;
    if (!seeder.identity) return;

    // bug on furrows due to furrow method on torrent seeder (proxy)?????
    // ids do not match cause it doesnt swap over
    if (
      msg.furrow &&
      !seeder.furrows.find((f) => f?.identifier === msg.furrow?.id)
    )
      return;

    const message = new TorrentMessage(
      msg.message?.body || null,
      msg.message?.properties,
    );
    const msg_bytes = await seeder.identity?.sign(
      TorrentUtils.to_array_buffer(message.body),
    );
    const signature = await seeder.identity?.sign(msg_bytes);

    const control: TorrentControlMessage = {
      ...msg,
      type: "PUBLISH",
      control_id: TorrentUtils.random_string(),
      seeder: {
        id: seeder.identifier,
        name: seeder.name,
        public_key: seeder.public_key,
      },
      furrow: msg?.furrow,
      message: {
        body: msg.message?.body,
        properties: msg.message?.properties,
      },
      artifacts: {
        signature: TorrentUtils.to_base64_url(signature),
        timestamp: Date.now(),
      },
    };

    // send to ourselves???
    this._handle_receive(control);
    // this is duplicate sending cause it also forwards the message
    // this._broadcast_control(control);
  }

  private _handle_receive(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    // ignore if message from self
    if (msg.from === this.identifier) return;

    // already processed, skip entirely
    if (this.data_store.has(msg.control_id)) return;
    this.store(msg);

    this._forward_msg(msg).then();

    // Local routing: accept message if routing_key matches this.identifier or empty
    const routing_key = msg.message?.properties?.routing_key ?? "";

    if (!routing_key || routing_key === this.identifier) {
      const tmsg = new TorrentMessage(msg.message?.body ?? null);
      tmsg.properties = msg.message?.properties ?? {};
      this.emit("MESSAGE_RECEIVE", msg);
    }

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
            this.emit("MESSAGE_RECEIVE", {
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
          this.emit("MESSAGE_RECEIVE", msg);
        }
      }
    }
  }

  private _handle_found(
    msg: Extract<TorrentControlMessage, { type: "FOUND" }>,
  ) {
    const { seeder, furrow } = msg;
    const seeder_name = seeder.seeder_name;

    this.emit("FOUND", {
      seeder,
      furrow,
      peer_id: msg.from,
    });

    // remove from locally hosted seeder with that name
    // messages should not be should not be routed using it
    this.seeders = this.seeders.filter((s) => s.name !== seeder_name);

    this._remove_from_hosted(seeder_name, furrow?.furrow_name);

    const binding = this._search_broker_bindings(
      seeder_name,
      furrow?.furrow_name,
    );

    if (!binding.seeder) return;

    // replace local binding with authoritative remote seeder
    this.unregister_remote_binding(binding.seeder);
    this.register_remote_binding({
      id: seeder.id,
      name: seeder_name,
      public_key: seeder.public_key,
    });

    if (!binding.furrow || !furrow) return;

    this.unregister_remote_binding(binding.seeder, binding.furrow);

    this.register_remote_binding(
      {
        id: seeder.id,
        name: seeder_name,
        public_key: seeder.public_key,
      },
      {
        id: furrow.id,
        name: furrow.furrow_name,
        routing_key: binding.furrow.routing_key,
      },
    );
  }

  private _search_broker_bindings(seeder: string, furrow?: string) {
    const obj: {
      seeder?: { id: string; name: string; public_key?: JsonWebKey };
      furrow?: { id: string; name: string; routing_key: string };
    } = {};
    for (const [seeder_entry, furrow_set] of this.broker_bindings) {
      const deserialized_seeder = this.utils.deserialize(seeder_entry);

      if (
        deserialized_seeder.seeder_id !== seeder &&
        deserialized_seeder.name !== seeder
      )
        continue;
      obj.seeder = {
        id: deserialized_seeder.seeder_id,
        name: deserialized_seeder.name,
        ...(deserialized_seeder.public_key
          ? { public_key: deserialized_seeder.public_key }
          : {}),
      };

      if (furrow) {
        for (const furrow_entry of furrow_set) {
          const deserialized_furrow = this.utils.deserialize(furrow_entry);
          if (
            deserialized_furrow.name === furrow ||
            deserialized_furrow.furrow_id === furrow
          ) {
            obj.furrow = {
              id: deserialized_furrow.furrow_id,
              name: deserialized_furrow.name,
              routing_key: deserialized_furrow.routing_key,
            };
          }
        }
      }
    }

    return obj;
  }

  private _search_seeder_or_furrow(
    control: Extract<TorrentControlMessage, { type: "FIND" }>,
  ) {
    const fnd_msg: TorrentControlMessage = {
      type: "FOUND",
      control_id: TorrentUtils.random_string(),
      from: this.identifier,
      to: control.from,
      seeder: undefined as any, // fill in later
    };

    for (const [seeder_entry, furrow_set] of this.hosted) {
      const real_seeder = this.utils.deserialize(seeder_entry);

      if (real_seeder.seeder_name !== control.seeder.name) continue;
      fnd_msg.seeder = real_seeder;

      if (control.furrow) {
        const req_furrow_name = control.furrow.name;

        for (const furrow_entry of furrow_set) {
          const real_furrow = this.utils.deserialize(furrow_entry);
          if (real_furrow.furrow_name !== req_furrow_name) continue;
          fnd_msg.furrow = real_furrow;
        }
      }
    }

    if (control.furrow ? fnd_msg.seeder && fnd_msg.furrow : fnd_msg.seeder)
      // Send FOUND back
      this._broadcast_control(fnd_msg);
    else
      this._broadcast_control({
        type: "NOT_FOUND",
        control_id: TorrentUtils.random_string(),
        from: this.identifier,
        to: control.from,
        seeder: control.seeder,
        furrow: control?.furrow,
      });
  }

  private _bind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow & { public_key?: JsonWebKey },
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: TorrentSeederBindingObj = {
      seeder_id: seeder.id,
      name: seeder.name,
      public_key: seeder.public_key,
    };
    let furrow_set = this.broker_bindings.get(this.utils.serialize(seeder_key));

    if (!furrow_set) {
      furrow_set = new Set();
      this.broker_bindings.set(this.utils.serialize(seeder_key), furrow_set);
    }

    if (furrow?.id && furrow?.name) {
      const furrow_key: TorrentFurrowBindingObj = {
        furrow_id: furrow.id,
        name: furrow.name,
        routing_key: furrow.routing_key ?? this.identifier,
      };
      furrow_set.add(this.utils.serialize(furrow_key));
    }
  }

  private _unbind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow & { public_key?: JsonWebKey },
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: TorrentSeederBindingObj = {
      seeder_id: seeder.id,
      name: seeder.name,
      public_key: seeder.public_key,
    };
    let furrow_set = this.broker_bindings.get(this.utils.serialize(seeder_key));

    if (!furrow_set && furrow) return;
    if (furrow?.id && furrow?.name) {
      const furrow_key: TorrentFurrowBindingObj = {
        furrow_id: furrow.id,
        name: furrow.name,
        routing_key: furrow.routing_key ?? this.identifier,
      };
      furrow_set?.delete(this.utils.serialize(furrow_key));
      return;
    }
    this.broker_bindings.delete(this.utils.serialize(seeder_key));
  }

  private async _forward_msg(
    control: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    const id = control.control_id;
    if (!id) return;
    if (this.data_store.has(id)) return;
    this.store(control);

    this._calculate_candidates(control).then(
      (res: { peer_id: string; ema: number }[]) => {
        for (const { peer_id } of res) {
          const entry = this.connected_peers.get(peer_id);
          if (!entry?.dc) continue;
          if (entry.dc && entry.dc.readyState === "open") {
            const new_control: TorrentControlMessage = {
              ...control,
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
            };

            try {
              entry.dc.send(JSON.stringify(new_control));
            } catch (e) {
              console.warn("failed to broadcast control to peer", e);
            }
          }
        }
      },
    );
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
  private async _calculate_candidates(
    control: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ): Promise<{ peer_id: string; ema: number }[]> {
    const seen = new Set<string>();
    const candidates: Array<{ peer_id: string; ema: number }> = [];
    const { seeder, furrow } = control;

    for (const [peer_id, entry] of this.connected_peers) {
      if (entry.bb) {
        let matched = false;
        for (const [seeder_entry, furrow_set] of entry.bb) {
          const [, real_name] = seeder_entry;
          if (real_name !== seeder.name) continue;

          if (furrow) {
            const req_furrow_name = furrow.name;
            for (const [, real_furrow_name] of furrow_set) {
              if (real_furrow_name === req_furrow_name) {
                matched = true;
                break;
              }
            }
          } else {
            matched = true;
          }
          if (matched) break;
        }
        if (matched && !seen.has(peer_id)) {
          entry.stats = entry.stats || {};
          candidates.push({ peer_id, ema: entry.stats.distance ?? Infinity });
          seen.add(peer_id);
        }
      }
    }

    const k_max = Math.ceil(Math.sqrt(candidates.length));
    const k = Math.min(k_max, candidates.length);

    candidates.sort((a, b) => a.ema - b.ema);
    return this._split_candidates(candidates, k);
  }

  // TODO: implement load balancing for sharing seeders
  // multiple peers hosting the same seeder but only part of it e.g. one furrow
  // private async _load_balance_control() {}
}
