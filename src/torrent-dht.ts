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
  TorrentSignalVia,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentDHTNode extends TorrentEmitter<
  | TorrentEventName
  | "control_message"
  | "status_update"
  | "swarm_key_exchanged"
  | "eph_exchange_init"
  | "eph_exchange_complete"
  | "pulse"
> {
  protected signal_store: TorrentLRUCache<string, TorrentSignalMessage> =
    new TorrentLRUCache<string, TorrentSignalMessage>(64);
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

  readonly min_peer_cluster_size: number = 4;
  readonly max_peer_cluster_size: number = 8;
  // frequency of sampling new peers
  readonly partition_heal_interval: number = 60000;
  // how often to get status in ms
  readonly status_frequency_check: number = 60000;

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
    this.signaller.on<TorrentSignalMessage>("message", (m) => {
      if (this.signal_store.has(m.signal_id)) return;

      this._handle_signal_message(m, "signaller");
      this.signal_store.set(m.signal_id, m);
    });

    // connect signaller and announce presence (HELO)
    // send HELO explicitly as a control message broadcast (server should re-broadcast)

    this.signaller.on("open", () => {
      try {
        const hello_broadcast: TorrentSignalMessage = {
          signal_id: TorrentUtils.random_string(),
          type: "HELO",
          from: this.identifier,
        };
        this.send(hello_broadcast);
        this.emit("signaller_connected");
      } catch (e) {
        console.warn("Failed to send HELO via signaller", e);
      }
    });

    setInterval(() => {
      if (this.connected_peers.size < this.min_peer_cluster_size)
        // request YOYO from signaller or reconnect to random known peer
        this.send({
          signal_id: TorrentUtils.random_string(),
          type: "YOYO",
          from: this.identifier,
        });

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
          signal_id: TorrentUtils.random_string(),
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

        this.send(status_broadcast);
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

    const lru_array = Array.from(this.data_store.get_map().values()).map(
      (node) => node.value,
    );
    const lru_array_buffer = TorrentUtils.to_array_buffer(lru_array);
    const lru_base64 = TorrentUtils.to_base64_url(lru_array_buffer);

    const lru_msg: Extract<TorrentControlMessage, { type: "LRU_STORE" }> = {
      control_id: TorrentUtils.random_string(),
      type: "LRU_STORE",
      from: this.identifier,
      to: to_peer_id,
      lru: lru_base64,
    };

    if (peer.dc && peer.dc.readyState === "open")
      peer.dc.send(JSON.stringify(lru_msg));
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

  private _handle_signal_message(
    msg: TorrentSignalMessage,
    via: TorrentSignalVia,
  ) {
    // ignore our own messages (except for signaller identify)
    if (msg.from === this.identifier) return;

    switch (msg.type) {
      case "HELO":
        return this._handle_helo(msg, via);
      case "HIHI":
        return this._handle_hihi(msg, via);
      case "YOYO":
        return this._handle_yoyo(msg, via);

      case "OFFER":
        return this._handle_offer(msg, via);
      case "ANSWER":
        return this._handle_answer(msg);
      case "ICE":
        return this._handle_ice(msg);
      case "STATUS":
        return this._handle_status(msg);
      default:
        // ignore unknown or control messages coming over websocket - we want control over DC only
        return;
    }
  }

  private _handle_helo(
    msg: Extract<TorrentSignalMessage, { type: "HELO" }>,
    via: TorrentSignalVia,
  ) {
    // HELO auto-discovery: when a peer broadcasts HELO we start initiating a connection to them
    // if we already have a connection to them, ignore
    if (this.connected_peers.has(msg.from)) return;

    if (this.connected_peers.size < this.max_peer_cluster_size) {
      const is_polite = this.identifier.localeCompare(msg.from) < 0;

      if (is_polite)
        // create pc + dc and send OFFER (deterministic tie-break inside)
        this._initiate_connection_to_peer(msg.from, via);
      else {
        // they might not have discovered this peer so say "HIHI"
        const hihi_broadcast: TorrentSignalMessage = {
          signal_id: TorrentUtils.random_string(),
          type: "HIHI",
          from: this.identifier,
          to: msg.from,
        };
        this.send(hihi_broadcast, via);
      }
    }
  }

  private _handle_hihi(
    msg: Extract<TorrentSignalMessage, { type: "HIHI" }>,
    via: TorrentSignalVia,
  ) {
    if (this.connected_peers.has(msg.from)) return;

    if (this.connected_peers.size < this.max_peer_cluster_size) {
      const is_polite = this.identifier.localeCompare(msg.from) < 0;
      if (is_polite) this._initiate_connection_to_peer(msg.from, via);
    }
  }

  private _handle_yoyo(
    msg: Extract<TorrentSignalMessage, { type: "YOYO" }>,
    via: TorrentSignalVia,
  ) {
    const target_id = msg.to ?? msg.from;
    if (this.connected_peers.has(target_id)) return;

    if (this.connected_peers.size < this.max_peer_cluster_size) {
      const is_polite = this.identifier.localeCompare(target_id) < 0;
      if (is_polite) this._initiate_connection_to_peer(target_id, via);
      else {
        // they might not have discovered this peer so say "YOYO"
        const yoyo_broadcast: TorrentSignalMessage = {
          signal_id: TorrentUtils.random_string(),
          type: "YOYO",
          from: this.identifier,
          to: msg.from,
        };
        this.send(yoyo_broadcast, via);
      }
    }
  }

  private async _handle_offer(
    msg: Extract<TorrentSignalMessage, { type: "OFFER" }>,
    via: TorrentSignalVia,
  ) {
    if (msg.to !== this.identifier) return;
    // Reject inbound offers when at capacity (unless we already have an entry for this peer)
    if (
      !this.connected_peers.has(msg.from) &&
      this.connected_peers.size >= this.max_peer_cluster_size
    )
      return;

    const entry =
      this.connected_peers.get(msg.from) ||
      this._create_peer_connection(msg.from);
    const pc: RTCPeerConnection = entry.pc;

    const is_polite = this.identifier.localeCompare(msg.from) < 0;

    try {
      const is_colliding = entry.making_offer || pc.signalingState !== "stable";

      // impolite: we ignore their offer (they will back down)
      // polite: we rollback our offer to accept theirs
      if (is_colliding) {
        if (!is_polite) return;
        await pc.setLocalDescription({ type: "rollback" });
        await pc.setRemoteDescription(msg.sdp);
        await this._flush_ice_candidates(entry);
      } else {
        await pc.setRemoteDescription(msg.sdp);
      }

      if (pc.signalingState !== "have-remote-offer") return;

      // create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // send answer back
      const resp: TorrentSignalMessage = {
        signal_id: TorrentUtils.random_string(),
        type: "ANSWER",
        from: this.identifier,
        to: msg.from,
        sdp: pc.localDescription as RTCSessionDescription,
      };

      this.send(resp, via);
    } catch (e) {
      // console.warn("failed to process offer", e);
    }
  }

  private async _handle_answer(
    msg: Extract<TorrentSignalMessage, { type: "ANSWER" }>,
  ) {
    const entry = this.connected_peers.get(msg.from);
    if (!entry) return;

    const pc: RTCPeerConnection = entry.pc;

    if (pc.signalingState === "stable") return;

    try {
      if (pc.signalingState === "have-local-offer")
        await pc.setRemoteDescription(msg.sdp);

      await this._flush_ice_candidates(entry);
    } catch (e) {
      // console.error("failed to apply remote answer", e);
    }
  }

  private async _handle_ice(
    msg: Extract<TorrentSignalMessage, { type: "ICE" }>,
  ) {
    const entry = this.connected_peers.get(msg.from);
    if (!entry) return;

    const pc: RTCPeerConnection = entry.pc;

    try {
      const { candidate } = msg;
      const is_accepting_ice =
        pc.remoteDescription?.type && pc.signalingState !== "closed";

      if (!is_accepting_ice) {
        entry.ice_queue = entry.ice_queue ?? [];
        entry.ice_queue.push(candidate);
        return;
      }

      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn("failed to add remote ICE candidate", e);
    }
  }

  private _handle_status(
    msg: Extract<TorrentSignalMessage, { type: "STATUS" }>,
  ) {
    // track which peers are connected to which
    // ensure to ignore self
    const connected_peers = new Set(msg?.stats?.connected_peers);

    // update graph entry for this peer
    this.peer_graph.set(msg.from, connected_peers);

    // Also make sure all peers exist in the graph (even if they have no connections yet)
    connected_peers.forEach((peer_id) => {
      if (!this.peer_graph.has(peer_id) && peer_id !== this.identifier) {
        this.peer_graph.set(peer_id, new Set());
      }
    });

    // msg.peers contains the peer stats from the remote node
    this.emit("status_update", msg);
  }

  private async _initiate_connection_to_peer(
    remote_id: string,
    via: TorrentSignalVia,
  ) {
    const is_polite = this.identifier.localeCompare(remote_id) < 0;

    const entry = this._create_peer_connection(remote_id, is_polite);
    const pc: RTCPeerConnection = entry.pc;

    if (!is_polite) return;

    // set making offer flag and create offer
    try {
      entry.making_offer = true;
      await pc.setLocalDescription();

      const msg: TorrentSignalMessage = {
        signal_id: TorrentUtils.random_string(),
        type: "OFFER",
        from: this.identifier,
        to: remote_id,
        sdp: pc.localDescription as RTCSessionDescription,
      };

      try {
        this.send(msg, via);
      } catch (e) {
        console.warn("failed to send offer via signaller", e);
      }
    } catch (e) {
      console.warn("failed while creating/sending offer", e);
    } finally {
      entry.making_offer = false;
    }
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

    if (create_dc) {
      dc = pc.createDataChannel("torrent-proto-channel");
      this._attach_dc_handlers(dc, remote_id);
    }

    // remote may create a datachannel; capture it
    pc.ondatachannel = (ev) => {
      const channel = ev.channel;
      this._attach_dc_handlers(channel, remote_id);

      // store dc
      const entry = this.connected_peers.get(remote_id);
      if (entry) entry.dc = channel;
      else
        this.connected_peers.set(remote_id, {
          pc,
          dc: channel,
          ice_queue: [],
          making_offer: false,
        });
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const cand_msg: TorrentSignalMessage = {
          signal_id: TorrentUtils.random_string(),
          type: "ICE",
          from: this.identifier,
          to: remote_id,
          candidate: ev.candidate.toJSON(),
        };
        try {
          this.send(cand_msg);
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

    const entry: TorrentPeerEntry = {
      pc,
      dc,
      ice_queue: [],
      making_offer: false,
    };
    this.connected_peers.set(remote_id, entry);

    return entry;
  }

  private _attach_dc_handlers(dc: RTCDataChannel, remote_id: string) {
    dc.onopen = () => {
      // store dc on the peer entry (defensive)
      const entry = this.connected_peers.get(remote_id);
      if (entry) entry.dc = dc;

      const bb_array = Array.from(this.broker_bindings).map(
        ([seeder, furrowSet]) => ({
          seeder,
          furrows: Array.from(furrowSet),
        }),
      );
      const bb_array_buffer = TorrentUtils.to_array_buffer(bb_array);
      const bb_base64 = TorrentUtils.to_base64_url(bb_array_buffer);

      const bb_msg: Extract<
        TorrentControlMessage,
        { type: "BROKER_MANIFEST" }
      > = {
        control_id: TorrentUtils.random_string(),
        type: "BROKER_MANIFEST",
        from: this.identifier,
        manifest: bb_base64,
      };

      try {
        dc.send(JSON.stringify(bb_msg));
      } catch (e) {
        console.warn("Failed to send announce broke bindings", e);
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

        if (TorrentUtils.is_signal_message(parsed)) {
          if (this.signal_store.has(parsed.signal_id)) return;

          this._broadcast_to_peers(parsed);
          this._handle_signal_message(
            parsed as TorrentSignalMessage,
            "data_channel",
          );
          this.signal_store.set(parsed.signal_id, parsed);
        } else
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

  private async _flush_ice_candidates(entry: TorrentPeerEntry) {
    if (!entry.ice_queue || entry.ice_queue.length === 0) return;
    const pc = entry.pc;

    if (!pc.remoteDescription) return;

    while (entry.ice_queue.length > 0) {
      const candidate = entry.ice_queue.shift();
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("failed to add queued ICE candidate", e);
      }
    }
  }

  private send(msg: TorrentSignalMessage, via: TorrentSignalVia = "signaller") {
    if (!this._is_cluster_healthy() && via === "data_channel")
      via = "signaller";

    if (via === "signaller")
      try {
        this.signaller.send(msg);
      } catch (e) {
        console.warn("failed to send offer via signaller", e);
      }
    else {
      const sent_to_peers = this._broadcast_to_peers(msg);
      if (!sent_to_peers)
        try {
          this.signaller.send(msg);
        } catch (e) {
          console.warn("failed to send offer via signaller", e);
        }
    }

    this.signal_store.set(msg.signal_id, msg);
  }

  private _broadcast_to_peers(msg: TorrentSignalMessage) {
    if (this.signal_store.has(msg.signal_id)) return;

    const active_peers = Array.from(this.connected_peers.entries()).filter(
      ([, entry]) => entry?.dc && entry.dc.readyState === "open",
    );

    if (active_peers.length === 0) return false;

    let target: TorrentPeerEntry | undefined;
    if (msg.to) {
      const match = active_peers.find(([id]) => msg.to === id);
      if (match) target = match[1];
    }

    if (!target)
      for (const [, peer] of active_peers) {
        try {
          peer.dc!.send(JSON.stringify(msg));
        } catch (e) {
          console.warn("failed to broadcast signal to peer", e);
        }
      }
    else
      try {
        target.dc!.send(JSON.stringify(msg));
      } catch (e) {
        console.warn("failed to broadcast signal to peer", e);
      }

    return true;
  }

  private _is_cluster_healthy() {
    let count = 0;
    for (const entry of this.connected_peers.values()) {
      if (
        entry?.dc?.readyState === "open" &&
        ++count >= this.min_peer_cluster_size
      )
        return true;
    }
    return false;
  }

  // Heuristics

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
