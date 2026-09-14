import { TorrentUtils } from "./torrent-utils";
import { TorrentSignaller } from "./torrent-signaller";
import { TorrentError } from "./torrent-error";
import type {
  TorrentSignalMessage,
  TorrentWebSocketUrl,
  TorrentPeerEntry,
  TorrentControlMessage,
  TorrentPeerOptions,
  TorrentSeederParams,
} from "./torrent-types";
import { TorrentSeeder } from "./torrent-seeder";
import { TorrentPeerContext } from "./contexts/torrent-peer-context";

export class TorrentPeer {
  private signaller: TorrentSignaller;
  protected connected: boolean = false;
  private readonly options: TorrentPeerOptions;

  protected ctx: TorrentPeerContext;
  protected seeders: Map<string, TorrentSeeder> = new Map();

  constructor({
    store_size = 1024,
    min_cluster_size = 4,
    max_cluster_size = 8,
    stats_refresh_interval = 60000,
    partion_heal_interval = 60000,
    server_url,
  }: TorrentPeerOptions & {
    server_url?: TorrentWebSocketUrl;
    store_size?: number;
  } = {}) {
    this.options = {
      min_cluster_size,
      max_cluster_size,
      stats_refresh_interval,
      partion_heal_interval,
    };
    this.ctx = new TorrentPeerContext(store_size);
    this.signaller = new TorrentSignaller();

    this.signaller.connect(server_url);
    this.signaller.on({
      open: () => {
        this.connected = true;
        this.signaller.send({
          message_id: TorrentUtils.random_string(),
          type: "HELO",
          from: this.ctx.identifier,
        });
      },
      close: () => {
        this.signaller.send({
          message_id: TorrentUtils.random_string(),
          type: "BYE",
          from: this.ctx.identifier,
        });
      },
      message: (m: TorrentSignalMessage) => {
        this._handle_signal_message(m);
      },
    });

    setInterval(() => {
      this.ctx.connected_peers.forEach((p) =>
        TorrentUtils._get_connection_cost(p.pc).then(
          (res) =>
            (p.stats = {
              cost: res.cost,
              quality: res.quality,
              rtt: res.rtt,
              plr: res.plr,
              jitter: res.jitter,
              aob: res.aob,
              distance: TorrentUtils._ema_distance(
                p.stats?.distance ?? 0,
                res.cost,
              ),
            }),
        ),
      );
    }, stats_refresh_interval);
  }

  seeder(
    arg1?: string | TorrentSeederParams,
    arg2?: string | TorrentSeederParams,
  ) {
    if (!this.connected)
      throw new TorrentError("You must connect to an RTC client");
    let name: string | undefined;
    let options: TorrentSeederParams | undefined;

    for (const arg of [arg1, arg2]) {
      if (typeof arg === "string") name = arg;
      else if (arg) options = arg;
    }

    if (name) {
      const existing = this.seeders.get(name);
      if (existing) return existing;
    }

    const seeder = new TorrentSeeder(this.ctx, name, options);
    this.seeders.set(seeder.name, seeder);

    return seeder;
  }

  private _handle_signal_message(msg: TorrentSignalMessage) {
    if (msg.from === this.ctx.identifier) return;
    if (this.ctx.store.has(msg.message_id)) return;

    switch (msg.type) {
      case "HELO":
        return this._handle_helo(msg);
      case "HIHI":
        return this._handle_hihi(msg);

      case "OFFER":
        return this._handle_offer(msg);
      case "ANSWER":
        return this._handle_answer(msg);
      case "ICE":
        return this._handle_ice(msg);

      default:
        // ignore unknown or control messages coming over websocket
        this.ctx.store.set(msg.message_id, msg);
        return;
    }
  }

  private _handle_helo(msg: Extract<TorrentSignalMessage, { type: "HELO" }>) {
    // HELO auto-discovery: when a peer broadcasts HELO we start initiating a connection to them
    // if we already have a connection to them, ignore
    if (this.ctx.connected_peers.has(msg.from)) return;

    // create pc + dc and send OFFER
    this._initiate_connection_to_peer(msg.from);
    // they might not have discovered this peer so say "HIHI"
    this.signaller.send({
      message_id: TorrentUtils.random_string(),
      type: "HIHI",
      from: this.ctx.identifier,
      to: msg.from,
    });
  }

  private _handle_hihi(msg: Extract<TorrentSignalMessage, { type: "HIHI" }>) {
    if (this.ctx.connected_peers.has(msg.from)) return;
    this._initiate_connection_to_peer(msg.from);
  }

  private async _handle_offer(
    msg: Extract<TorrentSignalMessage, { type: "OFFER" }>,
  ) {
    if (msg.to !== this.ctx.identifier) return; // reject if offer not to us

    try {
      const entry = this._create_peer_connection(msg.from);
      const pc: RTCPeerConnection = entry.pc;
      const is_polite = this.ctx.identifier.localeCompare(msg.from) < 0;

      if (pc.signalingState !== "stable") {
        if (!is_polite) return;
        await pc.setLocalDescription({ type: "rollback" });
        await pc.setRemoteDescription(msg.sdp);
        // await this._flush_ice_candidates(entry);
      } else {
        await pc.setRemoteDescription(msg.sdp);
      }

      if (pc.signalingState !== "have-remote-offer") return;

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // send answer back
      this.signaller.send({
        message_id: TorrentUtils.random_string(),
        type: "ANSWER",
        from: this.ctx.identifier,
        to: msg.from,
        sdp: pc.localDescription as RTCSessionDescription,
      });
    } catch (e) {}
  }

  private async _handle_answer(
    msg: Extract<TorrentSignalMessage, { type: "ANSWER" }>,
  ) {
    const entry = this.ctx.connected_peers.get(msg.from);
    if (!entry) return;

    const pc: RTCPeerConnection = entry.pc;

    if (pc.signalingState === "stable") return;

    try {
      if (pc.signalingState === "have-local-offer")
        await pc.setRemoteDescription(msg.sdp);

      // await this._flush_ice_candidates(entry);
    } catch (e) {}
  }

  private async _handle_ice(
    msg: Extract<TorrentSignalMessage, { type: "ICE" }>,
  ) {
    const entry = this.ctx.connected_peers.get(msg.from);
    if (!entry) return;

    const pc: RTCPeerConnection = entry.pc;

    try {
      const { candidate } = msg;
      await pc.addIceCandidate(candidate);
    } catch (e) {}
  }

  private async _initiate_connection_to_peer(peer_id: string) {
    // deterministic tie-break
    const is_polite = this.ctx.identifier.localeCompare(peer_id) < 0;

    const entry = this._create_peer_connection(peer_id, is_polite);
    const pc: RTCPeerConnection = entry.pc;

    if (!is_polite) return;

    // set making offer flag and create offer
    try {
      // entry.making_offer = true;
      await pc.setLocalDescription();

      this.signaller.send({
        message_id: TorrentUtils.random_string(),
        type: "OFFER",
        from: this.ctx.identifier,
        to: peer_id,
        sdp: pc.localDescription as RTCSessionDescription,
      });
    } catch (e) {
      console.warn("failed while creating/sending offer", e);
    } finally {
      // entry.making_offer = false;
    }
  }

  private _create_peer_connection(peer_id: string, create_dc: boolean = false) {
    // if existing peer connection exists, return it
    const existing = this.ctx.connected_peers.get(peer_id);
    if (existing) return existing;

    const pc = new RTCPeerConnection();
    let dc: RTCDataChannel | undefined;

    if (create_dc) {
      dc = pc.createDataChannel("torrent-proto-channel");
      this._attach_dc_handlers(dc, peer_id);
    }

    const entry: TorrentPeerEntry = {
      pc,
      dc,
      // ice_queue: [],
      // making_offer: false,
    };
    this.ctx.connected_peers.set(peer_id, entry);
    this._attach_pc_handlers(pc, peer_id);

    return entry;
  }

  private _attach_pc_handlers(pc: RTCPeerConnection, peer_id: string) {
    // remote may create a datachannel; capture it
    pc.ondatachannel = (ev) => {
      const channel = ev.channel;
      this._attach_dc_handlers(channel, peer_id);

      // store dc
      const entry = this.ctx.connected_peers.get(peer_id);
      if (entry) entry.dc = channel;
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate)
        this.signaller.send({
          message_id: TorrentUtils.random_string(),
          type: "ICE",
          from: this.ctx.identifier,
          to: peer_id,
          candidate: ev.candidate,
        });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (
        state === "disconnected" ||
        state === "failed" ||
        state === "closed"
      ) {
        this.ctx.connected_peers.delete(peer_id);
      }
    };
  }

  private _attach_dc_handlers(dc: RTCDataChannel, peer_id: string) {
    dc.onmessage = (ev) => {
      try {
        const parsed =
          typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;

        this._handle_control_message(parsed as TorrentControlMessage);
      } catch (e) {
        new TorrentError(`Invalid control message from dc: ${ev}`);
      }
    };

    dc.onclose = () => {
      // clean up dead peers
      this.ctx.connected_peers.delete(peer_id);
    };
  }

  private async _handle_control_message(msg: TorrentControlMessage) {
    // NOTE: de-dup bullshit
    // ignore if message from self
    if (msg.from === this.ctx.identifier) return;
    // already processed, skip entirely
    if (this.ctx.store.has(msg.control_id)) return;

    const temp_msg = msg;
    // reset hop count for message verification
    if (temp_msg.type === "PUBLISH")
      temp_msg.message = {
        ...temp_msg.message,
        properties: {
          ...temp_msg.message.properties,
          headers: {
            ...temp_msg.message?.properties?.headers,
            hop_count: 0,
          },
        },
      };
    const { control_id, artifacts, ...msg_body } = temp_msg;
    const msg_bytes = TorrentUtils.to_array_buffer(msg_body);
    const valid = await TorrentUtils.verify_with_key(
      msg_bytes,
      TorrentUtils.base64_to_buffer(artifacts.signature),
      artifacts.public_key,
    );

    if (!valid)
      throw new TorrentError(
        "Malformed message received. The message may be corrupted or incorrectly formatted.",
      );

    // store in the data store so is ignored if re_delivered
    // only forward if not seen before or sent by us
    if (msg.from !== this.ctx.identifier) {
      // always forward if we are not the recepient
      if (msg.to !== this.ctx.identifier) this.ctx.publish(msg);
      // if message has no destination or it is to us store it
      // objects with access to the context can attach to the store
      // and handle messages themselves
      if (!msg.to || msg.to === this.ctx.identifier)
        this.ctx.store.set(msg.control_id, msg);
    }
  }
}
