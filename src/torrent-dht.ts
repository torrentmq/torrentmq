import { TorrentEmitter } from "./torrent-emitter";
import { TorrentLRUCache } from "./torrent-lru";
import { TorrentSignaller } from "./torrent-signaller";
import {
  TorrentBrokerBindings,
  TorrentControlMessage,
  TorrentEventName,
  TorrentPeerEntry,
  TorrentPeerQuality,
  TorrentSignalMessage,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentDHTNode extends TorrentEmitter<
  TorrentEventName | "CONTROL_MESSAGE" | "STATUS_UPDATE"
> {
  protected data_store: TorrentLRUCache<string, TorrentControlMessage>;
  // map of remote peer id -> TorrentPeerEntry { RTCPeerConnection, RTCDataChannel, TorrentBrokerBindings }
  protected connected_peers: Map<string, TorrentPeerEntry> = new Map();
  // map [seeder_id, seeder_name] -> [furrow_id, furrow_name, routing_key][]
  protected broker_bindings: TorrentBrokerBindings = new Map();

  protected utils: TorrentUtils = new TorrentUtils();
  private signaller: TorrentSignaller;

  protected peer_graph: Map<string, Set<string>> = new Map();
  readonly identifier: string = TorrentUtils.random_string(20);
  readonly min_peer_cluster_size: number = 3;
  readonly max_peer_cluster_size: number = 8;
  // frequency of sampling new peers
  readonly partition_heal_interval: number = 30000;
  // how often to get status in ms
  readonly status_frequency_check: number = 15000;

  constructor(options?: {
    ws_url?: string;
    min_peer_cluster_size?: number;
    max_peer_cluster_size?: number;
    status_frequency?: number;
    partion_heal_interval?: number;
    lru_size?: number;
  }) {
    super();

    this.data_store = new TorrentLRUCache<string, TorrentControlMessage>(
      options?.lru_size ?? 1024,
    );

    this.signaller = new TorrentSignaller(options?.ws_url);

    if (options) {
      if (options?.min_peer_cluster_size && options?.min_peer_cluster_size > 0)
        this.min_peer_cluster_size = options.min_peer_cluster_size;
      if (options?.max_peer_cluster_size && options?.max_peer_cluster_size > 0)
        this.max_peer_cluster_size = options.max_peer_cluster_size;
      if (options?.status_frequency && options?.status_frequency > 0)
        this.status_frequency_check = options.status_frequency;
      if (options?.partion_heal_interval && options?.partion_heal_interval > 0)
        this.partition_heal_interval = options.partion_heal_interval;
    }

    // route incoming signalling messages into this instance
    this.signaller.on_message = (m) => this._handle_signal_message(m);

    // connect signaller and announce presence (HELO)
    // NOTE: don't await in constructor; handle errors gracefully
    this.signaller
      .connect()
      .then(() => {
        try {
          // send HELO explicitly as a control message broadcast (server should re-broadcast)
          const hello_broadcast: TorrentSignalMessage = {
            type: "HELO",
            from: this.identifier,
          };
          this.signaller.send(hello_broadcast);
          this.emit("PEER_CONNECTED", { peer_id: this.identifier });
        } catch (e) {
          console.warn("failed to send HELO via signaller", e);
        }
      })
      .catch((err) => {
        console.warn("signaller connect failed", err);
      });

    setInterval(() => {
      // clean up dead peers
      // carry out before size checks to ensure
      // a. HELO messages are sent to connect to new peers
      // b. avoid removing some connected peers with data channels
      const peers_to_close = [];

      for (const [peer_id, peer] of this.connected_peers) {
        if (!peer.dc || peer.dc.readyState !== "open") {
          peers_to_close.push(peer_id);
        }
      }

      peers_to_close.forEach((peer_id) => this.close_peer_connection(peer_id));

      if (this.connected_peers.size < this.min_peer_cluster_size)
        // request HELO from signaller or reconnect to random known peer
        this.signaller.send({ type: "HELO", from: this.identifier });
      if (this.connected_peers.size > this.max_peer_cluster_size) {
        const worst_peer = this._get_worst_peer();
        if (worst_peer) this.close_peer_connection(worst_peer);
      }
    }, this.partition_heal_interval);

    setInterval(() => {
      this.connected_peers.forEach((p) =>
        this._get_connection_cost(p.pc).then(
          (res) =>
            (p.stats = {
              cost: res.cost,
              quality: res.quality,
              rtt: res.rtt,
              plr: res.plr,
              jitter: res.jitter,
              aob: res.aob,
              distance: this._ema_distance(p.stats?.distance ?? 0, res.cost),
            }),
        ),
      );

      const peer_metrics = Array.from(this.connected_peers.values());

      const avg_rtt =
        peer_metrics.reduce((a, b) => a + (b?.stats?.rtt ?? 0), 0) /
          peer_metrics.length || 0;
      const avg_plr =
        peer_metrics.reduce((a, b) => a + (b?.stats?.plr ?? 0), 0) /
          peer_metrics.length || 0;

      if (this.connected_peers.size > 0) {
        const status_broadcast: TorrentSignalMessage = {
          type: "STATUS",
          from: this.identifier,
          stats: {
            rtt: avg_rtt,
            plr: avg_plr,
            accepting_connections:
              this.connected_peers.size < this.max_peer_cluster_size,
            connected_peers: [...this.connected_peers.keys()],
          },
        };

        this.signaller.send(status_broadcast);
      }
    }, this.status_frequency_check);
  }

  store(data: TorrentControlMessage) {
    if (this.identifier !== data.from)
      this.data_store.set(data.control_id, data);
    this.replicate_data(data);
  }

  retrieve(key: string) {
    if (this.data_store.has(key)) return this.data_store.get(key);
    else return null;
  }

  replicate_data(data: TorrentControlMessage) {
    this.connected_peers.forEach((peer) => {
      if (peer.dc && peer.dc.readyState === "open")
        peer.dc.send(JSON.stringify(data));
    });
  }

  get_network_graph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    this.peer_graph.forEach((neighbors, peer_id) => {
      graph.set(peer_id, Array.from(neighbors));
    });
    return graph;
  }

  close_peer_connection(peer_id: string) {
    const entry = this.connected_peers.get(peer_id);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (e) {}
    this.connected_peers.delete(peer_id);
    this.peer_graph.delete(peer_id);
    this.emit("PEER_DISCONNECTED", { peer_id: peer_id });
  }

  private _create_peer_connection(
    remote_id: string,
    create_dc = false,
  ): TorrentPeerEntry {
    // if existing peer connection exists, return it
    const existing = this.connected_peers.get(remote_id);
    if (existing) return existing;

    const pc = new RTCPeerConnection();
    let dc: RTCDataChannel | undefined;

    // if we expect to create the datachannel locally (we are the deterministic offerer)
    if (create_dc) {
      dc = pc.createDataChannel(TorrentUtils.random_string());
      this._attach_dc_handlers(dc, remote_id);
    }

    // remote may create a datachannel; capture it
    pc.ondatachannel = (ev) => {
      const channel = ev.channel;
      this._attach_dc_handlers(channel, remote_id);

      // store dc
      const e = this.connected_peers.get(remote_id);
      if (e) e.dc = channel;
      else {
        // ensure iceQueue and flags exist even if we hadn't created the entry
        this.connected_peers.set(remote_id, {
          pc,
          dc: channel,
        });
        const created = this.connected_peers.get(remote_id)!;
        created.ice_queue = created.ice_queue ?? [];
        created.making_offer = created.making_offer ?? false;
        created.israp = created.israp ?? false;
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const cand_msg: TorrentSignalMessage = {
          type: "ICE",
          from: this.identifier,
          to: remote_id,
          candidate: ev.candidate.toJSON(),
        };
        try {
          this.signaller.send(cand_msg);
        } catch (e) {
          console.warn("failed to send ice candidate via signaller", e);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      // emit disconnected on closed / failed
      const state = pc.connectionState;
      if (state === "connected") {
        // nothing: datachannel open will emit PEER_CONNECTED
      } else if (
        state === "disconnected" ||
        state === "failed" ||
        state === "closed"
      ) {
        this.connected_peers.delete(remote_id);
        this.peer_graph.delete(remote_id);
        this.emit("PEER_DISCONNECTED", { peer_id: remote_id });
      }
    };

    // create entry and initialize our helper fields
    const entry: TorrentPeerEntry = { pc, dc };
    // attach runtime-only helpers (avoid having to change external types immediately)
    entry.ice_queue = [];
    entry.making_offer = false;
    entry.israp = false;

    this.connected_peers.set(remote_id, entry);
    return entry;
  }

  private _attach_dc_handlers(dc: RTCDataChannel, remote_id: string) {
    dc.onopen = () => {
      // store dc on the peer entry (defensive)
      const entry = this.connected_peers.get(remote_id);
      if (entry) entry.dc = dc;

      // announce binds for currently bound seeders when channel opens
      for (const [seeder, furrow_set] of this.broker_bindings) {
        const deserialized_seeder = this.utils.deserialize(seeder);

        const announce: TorrentControlMessage = {
          type: "ANNOUNCE_BIND",
          control_id: TorrentUtils.random_string(),
          from: this.identifier,
          seeder: {
            id: deserialized_seeder.seeder_id,
            name: deserialized_seeder.name,
          },
        };

        if (furrow_set.size > 0) {
          for (const furrow of furrow_set) {
            const deserialized_furrow = this.utils.deserialize(furrow);

            const announce_with_furrow: TorrentControlMessage = {
              ...announce,
              furrow: {
                id: deserialized_furrow.furrow_id,
                name: deserialized_furrow.name,
                routing_key: deserialized_furrow.routing_key,
              },
            };
            try {
              dc.send(JSON.stringify(announce_with_furrow));
            } catch (e) {
              console.warn("Failed to send announce for furrow", e);
            }
          }
        } else {
          try {
            dc.send(JSON.stringify(announce));
          } catch (e) {
            console.warn(
              "Failed to send announce for seeder without furrows",
              e,
            );
          }
        }
      }

      // notify listeners
      this.emit("PEER_CONNECTED", { peer_id: remote_id, dc });
    };

    dc.onmessage = (ev) => {
      try {
        const parsed =
          typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        this.emit("CONTROL_MESSAGE", {
          parsed: parsed as TorrentControlMessage,
          remote_id,
        });
      } catch (e) {
        console.warn("invalid control message from dc", ev.data);
      }
    };

    dc.onclose = () => {
      this.connected_peers.delete(remote_id);
      this.peer_graph.delete(remote_id);
      this.emit("PEER_DISCONNECTED", { peer_id: remote_id });
    };
  }

  private async _initiate_connection_to_peer(remote_id: string) {
    // deterministic tie-break: lexicographic compare of identifiers
    const i_am_offerer = this.identifier.localeCompare(remote_id) > 0;

    // create pc and optionally datachannel only if we are the designated offerer
    const entry = this._create_peer_connection(remote_id, i_am_offerer);
    const pc = entry.pc as RTCPeerConnection;

    // If we're not the offerer, do not create an offer now — wait for the remote OFFER and for ondatachannel.
    if (!i_am_offerer) {
      return;
    }

    // Offerer flow: set makingOffer flag and create offer
    try {
      entry.making_offer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const msg: TorrentSignalMessage = {
        type: "OFFER",
        from: this.identifier,
        to: remote_id,
        sdp: offer,
      };

      try {
        this.signaller.send(msg);
      } catch (e) {
        console.warn("failed to send offer via signaller", e);
      }
    } catch (e) {
      console.warn("failed while creating/sending offer", e);
    } finally {
      entry.making_offer = false;
    }
  }

  private _handle_signal_message(msg: TorrentSignalMessage) {
    // ignore our own messages (except for signaller identify)
    if (msg.type !== "SIGNALLER" && msg.from === this.identifier) return;

    switch (msg.type) {
      case "HELO":
        return this._handle_helo(
          msg as Extract<TorrentSignalMessage, { type: "HELO" }>,
        );
      case "HIHI":
        return this._handle_hihi(
          msg as Extract<TorrentSignalMessage, { type: "HIHI" }>,
        );
      case "OFFER":
        return this._handle_offer(
          msg as Extract<TorrentSignalMessage, { type: "OFFER" }>,
        );
      case "ANSWER":
        return this._handle_answer(
          msg as Extract<TorrentSignalMessage, { type: "ANSWER" }>,
        );
      case "ICE":
        return this._handle_ice(
          msg as Extract<TorrentSignalMessage, { type: "ICE" }>,
        );
      case "STATUS":
        return this._handle_status(
          msg as Extract<TorrentSignalMessage, { type: "STATUS" }>,
        );
      default:
        // ignore unknown or control messages coming over websocket - we want control over DC only
        return;
    }
  }

  private async _handle_offer(
    msg: Extract<TorrentSignalMessage, { type: "OFFER" }>,
  ) {
    const remote_id = msg.from;
    // only handle offers that are actually for us
    if (msg.to && msg.to !== this.identifier) return;

    // ensure entry exists (we are the non-offerer or we didn't initiate connection)
    let entry = this.connected_peers.get(remote_id);

    if (!entry) {
      entry = this._create_peer_connection(remote_id, false);
    }

    const pc: RTCPeerConnection = entry.pc;

    // negotiation: handle glare
    const offerCollision =
      entry.making_offer === true || pc.signalingState !== "stable";

    if (offerCollision) {
      try {
        // rollback local description if necessary - some browsers require this guard
        await pc.setLocalDescription({ type: "rollback" });
      } catch (e) {
        // some browsers throw here, just warn
        console.warn("rollback failed during offer handling", e);
      }
    }

    try {
      // set remote description from the offer
      await pc.setRemoteDescription(msg.sdp);

      // flush queued ICE candidates (if any)
      if (entry.ice_queue && entry.ice_queue.length) {
        for (const c of entry.ice_queue) {
          try {
            // candidate could be RTCIceCandidateInit or null-ish
            if (c) await pc.addIceCandidate(c);
          } catch (err) {
            console.warn(
              "queued ice failed to add (during offer handling)",
              err,
            );
          }
        }
        entry.ice_queue = [];
      }

      // create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // send answer back
      const resp: TorrentSignalMessage = {
        type: "ANSWER",
        from: this.identifier,
        to: remote_id,
        sdp: answer,
      };
      try {
        this.signaller.send(resp);
      } catch (e) {
        console.warn("failed to send answer via signaller", e);
      }
    } catch (e) {
      console.warn("failed to process offer", e);
    }
  }

  private async _handle_answer(
    msg: Extract<TorrentSignalMessage, { type: "ANSWER" }>,
  ) {
    const remote_id = msg.from;
    const entry = this.connected_peers.get(remote_id);

    if (!entry) return;

    try {
      const pc: RTCPeerConnection = entry.pc;
      // Only set remote description if we previously had a local offer
      if (
        pc.signalingState === "have-local-offer" ||
        pc.signalingState === "stable"
      ) {
        await pc.setRemoteDescription(msg.sdp);

        // flush queued ICE candidates
        if (entry.ice_queue && entry.ice_queue.length) {
          for (const c of entry.ice_queue) {
            try {
              if (c) await pc.addIceCandidate(c);
            } catch (err) {
              console.warn(
                "queued ice failed to add (during answer handling)",
                err,
              );
            }
          }
          entry.ice_queue = [];
        }
      } else {
        // If signaling state is unexpected, still attempt to set remote description defensively.
        try {
          await pc.setRemoteDescription(msg.sdp);
          if (entry.ice_queue && entry.ice_queue.length) {
            for (const c of entry.ice_queue) {
              try {
                if (c) await pc.addIceCandidate(c);
              } catch (err) {
                console.warn("queued ice failed (fallback answer path)", err);
              }
            }
            entry.ice_queue = [];
          }
        } catch (e) {
          console.warn("failed to apply remote answer", e);
        }
      }
    } catch (e) {
      console.warn("failed to apply remote answer", e);
    }
  }

  private async _handle_ice(
    msg: Extract<TorrentSignalMessage, { type: "ICE" }>,
  ) {
    const remote_id = msg.from;
    const entry = this.connected_peers.get(remote_id);
    if (!entry) return;

    try {
      const pc: RTCPeerConnection = entry.pc;

      // Defensive: ensure candidate object exists
      const candidate_init = msg.candidate;

      // If remoteDescription isn't set yet, queue the candidate
      const remote_desc = pc.remoteDescription;
      const remote_desc_applied = !!(remote_desc && remote_desc.type);

      if (!remote_desc_applied) {
        entry.ice_queue = entry.ice_queue ?? [];
        entry.ice_queue.push(candidate_init);
        return;
      }

      // Otherwise, add candidate right away
      await pc.addIceCandidate(candidate_init);
    } catch (e) {
      console.warn("failed to add remote ice candidate", e);
    }
  }

  private _handle_helo(msg: Extract<TorrentSignalMessage, { type: "HELO" }>) {
    // HELO auto-discovery: when a peer broadcasts HELO we start initiating a connection to them
    const from = msg.from;
    // if we already have a connection to them, ignore
    if (from === this.identifier) return;
    if (this.connected_peers.has(from)) return;
    // dont add new peers when at max
    // disconnect if over max
    if (this.connected_peers.size >= this.max_peer_cluster_size) {
      const worst_peer = this._get_worst_peer();
      if (worst_peer) this.close_peer_connection(worst_peer);
    }

    if (this.connected_peers.size < this.max_peer_cluster_size) {
      // they might not have discovered this peer so say "HIHI"
      const hihi_broadcast: TorrentSignalMessage = {
        type: "HIHI",
        from: this.identifier,
        to: msg.from,
      };
      this.signaller.send(hihi_broadcast);

      // create pc + dc and send OFFER (deterministic tie-break inside)
      this._initiate_connection_to_peer(from);
    }
  }

  private _handle_hihi(msg: Extract<TorrentSignalMessage, { type: "HIHI" }>) {
    const from = msg.from;
    if (from === this.identifier) return;
    if (msg.to !== this.identifier) return;
    // initiate connection to the peer that sent HELO_ACK
    this._initiate_connection_to_peer(from);
  }

  private _handle_status(
    msg: Extract<TorrentSignalMessage, { type: "STATUS" }>,
  ) {
    const from = msg.from;
    if (from === this.identifier) return;

    // track which peers are connected to which
    // ensure to ignore self
    const connected_peers = new Set(msg?.stats?.connected_peers);

    // update graph entry for this peer
    this.peer_graph.set(from, connected_peers);

    // Also make sure all peers exist in the graph (even if they have no connections yet)
    connected_peers.forEach((peer_id) => {
      if (!this.peer_graph.has(peer_id) && peer_id !== this.identifier) {
        this.peer_graph.set(peer_id, new Set());
      }
    });

    // msg.peers contains the peer stats from the remote node
    this.emit("STATUS_UPDATE", msg);
  }

  private async _get_connection_cost(pc: RTCPeerConnection) {
    const stats = await pc.getStats();

    let rtt = 0;
    let available_outgoing_bitrate = 0;
    let jitter = 0;
    let packet_loss_ratio = 0;

    let packets_sent = 0;
    let packets_lost = 0;

    stats.forEach((report) => {
      // ICE candidate pair
      if (report.type === "candidate-pair" && report.state === "succeeded") {
        rtt = report.currentRoundTripTime || rtt;
        available_outgoing_bitrate = report.availableOutgoingBitrate || 0;
      }

      // Outbound (packets lost)
      if (report.type === "outbound-rtp") {
        packets_sent += report.packetsSent || 0;
        packets_lost += report.packetsLost || 0;
        jitter = report.jitter || jitter;
      }

      // Inbound
      if (report.type === "inbound-rtp") {
        packets_sent += report.packetsReceived || 0;
        packets_lost += report.packetsLost || 0;
        jitter = report.jitter || jitter;
      }
    });

    packet_loss_ratio = packets_sent > 0 ? packets_lost / packets_sent : 0;

    const cost =
      rtt * 1000 +
      packet_loss_ratio * 5000 +
      jitter * 1000 +
      1 / (available_outgoing_bitrate + 1);

    function _get_quality(): TorrentPeerQuality {
      if (rtt < 0.08 && packet_loss_ratio < 0.01 && jitter < 0.005)
        return "EXCELLENT";
      else if (rtt < 0.2 && packet_loss_ratio < 0.03 && jitter < 0.015)
        return "GOOD";
      else if (rtt < 0.5 && packet_loss_ratio < 0.08 && jitter < 0.03)
        return "FAIR";
      else if (rtt < 1.5 && packet_loss_ratio < 0.2 && jitter < 0.1)
        return "POOR";
      else if (rtt >= 1.5 || packet_loss_ratio >= 0.2 || jitter >= 0.1)
        return "BAD";
      else return "DEAD";
    }

    return {
      cost,
      rtt,
      plr: packet_loss_ratio,
      jitter,
      aob: available_outgoing_bitrate,
      quality: _get_quality(),
    };
  }

  // use Exponential Moving Average (EMA) as distance
  private _ema_distance(prev_distance: number, cost: number, alpha = 0.1) {
    return alpha * cost + (1 - alpha) * prev_distance;
  }

  // get the worst peer and evict
  private _get_worst_peer(): string | null {
    let worst_id: string | null = null;
    let worst_distance = -Infinity;

    this.connected_peers.forEach((peer, peer_id) => {
      const distance = peer.stats?.distance ?? Infinity;
      if (distance > worst_distance) {
        worst_distance = distance;
        worst_id = peer_id;
      }
    });

    return worst_id;
  }
}
