import { TorrentEmitter } from "./torrent-emitter";
import { TorrentIdentity } from "./torrent-identity";
import { TorrentLRUCache } from "./torrent-lru";
import { TorrentSignaller } from "./torrent-signaller";
import {
  TorrentBrokerBindings,
  TorrentControlMessage,
  TorrentEventName,
  TorrentPeerEntry,
  TorrentSignalMessage,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentDHTNode extends TorrentEmitter<
  TorrentEventName | "control_message" | "status_update" | "swarm_key_exchanged"
> {
  protected data_store: TorrentLRUCache<string, TorrentControlMessage>;
  // map of remote peer id -> TorrentPeerEntry { RTCPeerConnection, RTCDataChannel, TorrentBrokerBindings }
  protected connected_peers: Map<string, TorrentPeerEntry> = new Map();
  // map [seeder_id, seeder_name] -> [furrow_id, furrow_name, routing_key][]
  protected broker_bindings: TorrentBrokerBindings = new Map();

  protected utils: TorrentUtils = new TorrentUtils();
  private signaller: TorrentSignaller;

  protected peer_graph: Map<string, Set<string>> = new Map();

  protected identity: TorrentIdentity;
  identifier: string = TorrentUtils.random_string(20);

  readonly min_peer_cluster_size: number = 3;
  readonly max_peer_cluster_size: number = 8;
  // frequency of sampling new peers
  readonly partition_heal_interval: number = 30000;
  // how often to get status in ms
  readonly status_frequency_check: number = 15000;

  protected last_partition_heal: number = Date.now();

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

    this.signaller = new TorrentSignaller();
    this.signaller.connect(options?.ws_url);

    // assign identity for message signing and verification
    TorrentIdentity.create().then((identity) => {
      this.identity = identity;
      identity.get_identifier().then((id) => {
        this.identifier = id;
      });
    });

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
    this.signaller.on<TorrentSignalMessage>("message", (m) =>
      this._handle_signal_message(m),
    );

    // connect signaller and announce presence (HELO)
    // send HELO explicitly as a control message broadcast (server should re-broadcast)

    this.signaller.on("open", () => {
      try {
        const hello_broadcast: TorrentSignalMessage = {
          type: "HELO",
          from: this.identifier,
        };
        this.signaller.send(hello_broadcast);
        this.emit("peer_connected", { peer_id: this.identifier });
      } catch (e) {
        console.warn("Failed to send HELO via signaller", e);
      }
    });

    setInterval(() => {
      if (this.connected_peers.size < this.min_peer_cluster_size)
        // request YOYO from signaller or reconnect to random known peer
        this.signaller.send({ type: "YOYO", from: this.identifier });

      // only evict when "healing"
      // ik this is optimisation and not "healing" but fuck it
      this._evict_worst_peer();

      this.last_partition_heal = Date.now();
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
    // if (this.identifier !== data.from)
    this.data_store.set(data.control_id, data);
  }

  retrieve(key: string) {
    if (this.data_store.has(key)) return this.data_store.get(key);
    else return null;
  }

  sync(to_peer_id: string) {
    const peer = this.connected_peers.get(to_peer_id);
    if (!peer) return;

    for (const [, lru_node] of this.data_store.get_map()) {
      const lru_msg: Extract<TorrentControlMessage, { type: "LRU_STORE" }> = {
        control_id: TorrentUtils.random_string(),
        type: "LRU_STORE",
        from: this.identifier,
        to: to_peer_id,
        message: lru_node.value,
      };

      if (peer.dc && peer.dc.readyState === "open")
        peer.dc.send(JSON.stringify(lru_msg));
    }
  }

  replicate_data(data: TorrentControlMessage, to_peer_id?: string) {
    this.connected_peers.forEach((peer) => {
      if (peer.dc && peer.dc.readyState === "open")
        peer.dc.send(
          JSON.stringify({
            control_id: TorrentUtils.random_string(),
            type: "LRU_STORE",
            from: this.identifier,
            to: to_peer_id,
            message: data,
          }),
        );
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
    this.emit("peer_disconnected", { peer_id: peer_id });
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
        this.emit("peer_disconnected", { peer_id: remote_id });
      }
    };

    // create entry and initialize our helper fields
    const entry: TorrentPeerEntry = { pc, dc };
    // attach runtime-only helpers (avoid having to change external types immediately)
    entry.ice_queue = [];
    entry.making_offer = false;

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
        const deserialized_seeder = this.utils.deserialize_binding(seeder);

        const announce: TorrentControlMessage = {
          type: "ANNOUNCE_BIND",
          control_id: TorrentUtils.random_string(),
          from: this.identifier,
          seeder: {
            id: deserialized_seeder.id,
            name: deserialized_seeder.name,
          },
        };

        if (furrow_set.size > 0) {
          for (const furrow of furrow_set) {
            const deserialized_furrow = this.utils.deserialize_binding(furrow);

            const announce_with_furrow: TorrentControlMessage = {
              ...announce,
              furrow: {
                id: deserialized_furrow.id,
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

      // sync our messages only when a connection is intialised
      this.sync(remote_id);

      // notify listeners
      this.emit("peer_connected", { peer_id: remote_id, dc });
    };

    dc.onmessage = (ev) => {
      try {
        const parsed =
          typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        this.emit("control_message", {
          parsed: parsed as TorrentControlMessage,
          remote_id,
        });
      } catch (e) {
        console.warn("invalid control message from dc", ev.data);
      }
    };

    dc.onclose = () => {
      // clean up dead peers
      this.connected_peers.delete(remote_id);
      this.peer_graph.delete(remote_id);
      this.emit("peer_disconnected", { peer_id: remote_id });
    };
  }

  private async _initiate_connection_to_peer(remote_id: string) {
    // deterministic tie-break: lexicographic compare of identifiers
    const i_am_offerer = this.identifier.localeCompare(remote_id) > 0;

    // create pc and optionally datachannel only if we are the designated offerer
    const entry = this._create_peer_connection(remote_id, i_am_offerer);
    const pc: RTCPeerConnection = entry.pc;

    // If we're not the offerer, do not create an offer now — wait for the remote OFFER and for ondatachannel.
    if (!i_am_offerer) return;

    // Offerer flow: set makingOffer flag and create offer
    try {
      entry.making_offer = true;
      await pc.setLocalDescription();

      const msg: TorrentSignalMessage = {
        type: "OFFER",
        from: this.identifier,
        to: remote_id,
        sdp: pc.localDescription as RTCSessionDescription,
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
    if (msg.from === this.identifier) return;

    switch (msg.type) {
      case "HELO":
        return this._handle_helo(
          msg as Extract<TorrentSignalMessage, { type: "HELO" }>,
        );
      case "HIHI":
        return this._handle_hihi(
          msg as Extract<TorrentSignalMessage, { type: "HIHI" }>,
        );
      case "YOYO":
        return this._handle_yoyo(
          msg as Extract<TorrentSignalMessage, { type: "YOYO" }>,
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
    let entry =
      this.connected_peers.get(remote_id) ||
      this._create_peer_connection(remote_id, false);
    const pc: RTCPeerConnection = entry.pc;

    // negotiation: handle glare
    try {
      const is_polite = this.identifier.localeCompare(remote_id) < 0;
      const offer_collision =
        entry.making_offer === true || pc.signalingState !== "stable";

      // If there's a collision and we are impolite, we ignore their offer (they will back down)
      // If there's a collision and we are polite, we rollback our offer to accept theirs
      if (offer_collision) {
        if (!is_polite) return;
        await pc.setLocalDescription({ type: "rollback" });
        await pc.setRemoteDescription(msg.sdp);
        await this._flush_ice_candidates(entry);
      } else {
        await pc.setRemoteDescription(msg.sdp);
      }

      // create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // send answer back
      const resp: TorrentSignalMessage = {
        type: "ANSWER",
        from: this.identifier,
        to: remote_id,
        sdp: pc.localDescription as RTCSessionDescription,
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

    const pc: RTCPeerConnection = entry.pc;

    // If we aren't in the state to receive an answer, just drop it.
    if (pc.signalingState !== "have-local-offer") {
      console.warn("received unexpected answer in state:", pc.signalingState);
      return;
    }

    try {
      await pc.setRemoteDescription(msg.sdp);
      await this._flush_ice_candidates(entry);
    } catch (e) {
      console.error("failed to apply remote answer", e);
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
      // We only apply candidates if we have a remote description AND we aren't closed.
      const can_accept_ice =
        remote_desc && remote_desc.type && pc.signalingState !== "closed";

      if (!can_accept_ice) {
        entry.ice_queue = entry.ice_queue ?? [];
        entry.ice_queue.push(candidate_init);
        return;
      }

      // Otherwise, add candidate right away
      await pc.addIceCandidate(candidate_init);
    } catch (e) {
      console.warn("failed to add remote ICE candidate", e);
    }
  }

  private _handle_helo(msg: Extract<TorrentSignalMessage, { type: "HELO" }>) {
    // HELO auto-discovery: when a peer broadcasts HELO we start initiating a connection to them
    const from = msg.from;
    // if we already have a connection to them, ignore
    if (from === this.identifier) return;
    if (this.connected_peers.has(from)) return;

    if (this.connected_peers.size < this.max_peer_cluster_size) {
      const is_polite = this.identifier.localeCompare(from) < 0;

      if (is_polite) {
        // they might not have discovered this peer so say "HIHI"
        const hihi_broadcast: TorrentSignalMessage = {
          type: "HIHI",
          from: this.identifier,
          to: msg.from,
        };
        this.signaller.send(hihi_broadcast);
      } else
        // create pc + dc and send OFFER (deterministic tie-break inside)
        this._initiate_connection_to_peer(from);
    }
  }

  private _handle_hihi(msg: Extract<TorrentSignalMessage, { type: "HIHI" }>) {
    const from = msg.from;
    if (from === this.identifier) return;
    if (this.connected_peers.has(from)) return;

    if (this.connected_peers.size < this.max_peer_cluster_size) {
      const is_polite = this.identifier.localeCompare(from) < 0;
      if (!is_polite) this._initiate_connection_to_peer(from);
    }
  }

  private _handle_yoyo(msg: Extract<TorrentSignalMessage, { type: "YOYO" }>) {
    const from = msg.from;
    // if we already have a connection to them, ignore
    if (from === this.identifier) return;
    if (this.connected_peers.has(from)) return;

    if (this.connected_peers.size < this.max_peer_cluster_size) {
      // they might not have discovered this peer so say "YOYO"
      const yoyo_broadcast: TorrentSignalMessage = {
        type: "YOYO",
        from: this.identifier,
        to: msg.from,
      };
      this.signaller.send(yoyo_broadcast);

      if (msg?.to && msg?.to === this.identifier)
        // if there is a target and its us we should intiate connection
        // create pc + dc and send OFFER (deterministic tie-break inside)
        this._initiate_connection_to_peer(from);
    }
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
    this.emit("status_update", msg);
  }

  private async _flush_ice_candidates(entry: TorrentPeerEntry) {
    if (!entry.ice_queue || entry.ice_queue.length === 0) return;

    while (entry.ice_queue.length > 0) {
      const candidate = entry.ice_queue.shift();
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("failed to add queued ICE candidate", e);
      }
    }
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

    const quality = TorrentUtils.get_peer_quality({
      plr: packet_loss_ratio,
      jitter,
      rtt,
    });

    return {
      cost,
      rtt,
      plr: packet_loss_ratio,
      jitter,
      aob: available_outgoing_bitrate,
      quality,
    };
  }

  // use Exponential Moving Average (EMA) as distance
  private _ema_distance(prev_distance: number, cost: number, alpha = 0.1) {
    // honestly no clue what this is
    // but it is here and and that is what matters
    return alpha * cost + (1 - alpha) * prev_distance;
  }

  // get the worst peers that can be evicted
  private _get_worst_peers(num: number = 1) {
    return Array.from(this.connected_peers.entries())
      .sort(([, a], [, b]) => {
        const dist_a = a.stats?.distance ?? Infinity;
        const dist_b = b.stats?.distance ?? Infinity;
        return dist_b - dist_a; // descending (worst first)
      })
      .slice(0, num)
      .map(([peer_id]) => peer_id);
  }

  private _evict_worst_peer() {
    const overflow = this.connected_peers.size - this.max_peer_cluster_size + 1; // +1 to allow for adding one more peer
    if (overflow <= 0) return;

    const worst_peers = this._get_worst_peers(overflow);
    worst_peers.forEach((peer_id) => this.close_peer_connection(peer_id));
  }
}
