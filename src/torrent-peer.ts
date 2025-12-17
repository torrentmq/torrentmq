import { TorrentDHTNode } from "./torrent-dht";
import { TorrentMessage } from "./torrent-message";
import {
  TorrentControlMessage,
  TorrentMessageObject,
  TorrentControlSeederOrFurrow,
  TorrentControlBindFurrow,
} from "./torrent-types";

export class TorrentPeer extends TorrentDHTNode {
  // the hosted seeders and or furrows [seeder_name] -> [furrow_name][]
  private hosted: Map<[string], Set<[string]>> = new Map();
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

    this.on<{ parsed: TorrentControlMessage; remote_id: string }>(
      "CONTROL_MESSAGE",
      (data) => {
        this._handle_control_message(data.parsed, data.remote_id);
      },
    );

    this.on<{ dht_node_id: string }>(
      "PEER_CONNECTED",
      () => (this.is_connected = true),
    );
  }

  register_remote_binding(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    this._bind_seeder_or_furrow(seeder, furrow);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_BIND",
      control_id: this.utils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this.emit("BIND", { seeder, furrow });
    this._broadcast_control(control);
  }

  unregister_remote_binding(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    this._unbind_seeder_or_furrow(seeder, furrow);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_UNBIND",
      control_id: this.utils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this.emit("UNBIND", { seeder, furrow });
    this._broadcast_control(control);
  }

  publish(msg: {
    seeder: TorrentControlSeederOrFurrow;
    furrow?: TorrentControlSeederOrFurrow;
    message?: TorrentMessage;
  }) {
    const publish_msg: TorrentMessageObject = {
      body: msg.message?.body,
      properties: msg.message?.properties,
    };

    const control: TorrentControlMessage = {
      type: "PUBLISH",
      control_id: this.utils.random_string(),
      from: this.identifier,
      seeder: msg.seeder,
      furrow: msg?.furrow,
      message: publish_msg,
    };

    // send to all connected peers via datachannels if available
    this._handle_publish(control);
  }

  find(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    const control: TorrentControlMessage = {
      type: "FIND",
      control_id: this.utils.random_string(),
      from: this.identifier,
      seeder,
      furrow,
    };

    this._broadcast_control(control);
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
        const seeder_key: [string, string] = [
          control.seeder.id,
          control.seeder.name,
        ];
        let furrow_set = peer.bb.get(
          this.utils.serialize_binding_key(seeder_key),
        );

        if (!furrow_set) {
          // If no furrows are bound to this seeder yet, create a new Set
          furrow_set = new Set();
          peer.bb.set(this.utils.serialize_binding_key(seeder_key), furrow_set);
        }

        // If a furrow is provided, add the furrow to the set for this seeder
        if (control.furrow?.id && control.furrow?.name) {
          const furrow_key: [string, string, string] = [
            control.furrow.id,
            control.furrow.name,
            control.furrow.routing_key ?? from_peer_id ?? control.from,
          ];
          furrow_set.add(this.utils.serialize_binding_key(furrow_key));
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
        const seeder_key: [string, string] = [
          control.seeder.id,
          control.seeder.name,
        ];
        let furrow_set = peer.bb.get(
          this.utils.serialize_binding_key(seeder_key),
        );

        if (!furrow_set && control.furrow) break;
        if (control.furrow?.id && control.furrow?.name) {
          const furrow_key: [string, string, string] = [
            control.furrow.id,
            control.furrow.name,
            control.furrow.routing_key ?? from_peer_id ?? control.from,
          ];
          // Remove furrow
          furrow_set?.delete(this.utils.serialize_binding_key(furrow_key));
        }
        if (!control.furrow) {
          // Remove seeder
          peer.bb.delete(this.utils.serialize_binding_key(seeder_key));
        }

        this.emit("PEER_UNBIND", {
          seeder: control.seeder,
          furrow: control.furrow,
          peer_id: from_peer_id,
        });
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
        this._search_seeder_or_furrow(control, from_peer_id);
        break;
      }

      case "FOUND": {
        this.emit("FOUND", {
          seeder: control.seeder,
          furrow: control?.furrow,
          peer_id: from_peer_id,
        });
        // replace the local binding with the remote authoritative seeder
        this.register_remote_binding(control.seeder, control?.furrow);
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

  private _search_seeder_or_furrow(
    control: TorrentControlMessage,
    from_peer_id?: string,
  ) {
    if (control.type !== "FIND") return;

    const fnd_msg: TorrentControlMessage = {
      type: "FOUND",
      control_id: this.utils.random_string(),
      from: this.identifier,
      seeder: undefined as any, // fill in later
    };

    for (const [seeder_entry, furrow_set] of this.broker_bindings) {
      const [real_seeder_id, real_seeder_name] = seeder_entry;

      if (real_seeder_name !== control.seeder.name) continue;
      fnd_msg.seeder = {
        id: real_seeder_id,
        name: real_seeder_name,
      };

      if (control.furrow) {
        const req_furrow_name = control.furrow.name;

        for (const [real_furrow_id, real_furrow_name] of furrow_set) {
          if (real_furrow_name === req_furrow_name) {
            fnd_msg.furrow = {
              id: real_furrow_id,
              name: real_furrow_name,
            };
          }
        }
      }
    }

    // Send FOUND back directly to requester via DC if we have a DC, otherwise no-op
    if (from_peer_id) {
      this._broadcast_control(fnd_msg, from_peer_id);
    } else {
      // If no requester specified, broadcast to all DCs
      this._broadcast_control(fnd_msg);
    }
  }

  private _bind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: [string, string] = [seeder.id, seeder.name];
    let furrow_set = this.broker_bindings.get(
      this.utils.serialize_binding_key(seeder_key),
    );

    if (!furrow_set) {
      furrow_set = new Set();
      this.broker_bindings.set(
        this.utils.serialize_binding_key(seeder_key),
        furrow_set,
      );
    }

    if (furrow?.id && furrow?.name) {
      const furrow_key: [string, string, string] = [
        furrow.id,
        furrow.name,
        furrow.routing_key ?? this.identifier,
      ];
      furrow_set.add(this.utils.serialize_binding_key(furrow_key));
    }
  }

  private _unbind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    const seeder_key: [string, string] = [seeder.id, seeder.name];
    let furrow_set = this.broker_bindings.get(
      this.utils.serialize_binding_key(seeder_key),
    );

    if (!furrow_set && furrow) return;
    if (furrow?.id && furrow?.name) {
      const furrow_key: [string, string, string] = [
        furrow.id,
        furrow.name,
        furrow.routing_key ?? this.identifier,
      ];
      furrow_set?.delete(this.utils.serialize_binding_key(furrow_key));
      return;
    }
    this.broker_bindings.delete(this.utils.serialize_binding_key(seeder_key));
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
          const [, real_seeder_name] = seeder_entry;
          if (real_seeder_name !== seeder.name) continue;

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
  private async _load_balance_control() {}
}
