import { TorrentMessage } from "./torrent-message";
import { TorrentSignaller } from "./torrent-signaller";
import {
  TorrentControlMessage,
  TorrentMessageObject,
  TorrentPeerEntry,
  TorrentSignalMessage,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentPeer {
  // seeder_id -> set of peer_ids that reported they are bound to that seeder
  remote_bindings: Map<string, Set<string>> = new Map();

  // map of remote peer id -> PeerEntry
  private peers: Map<string, TorrentPeerEntry> = new Map();
  private bound_seeders: Set<string> = new Set();
  private bound_furrows: Set<string> = new Set();

  private signaller: TorrentSignaller;
  private utils: TorrentUtils = new TorrentUtils();

  readonly identifier: string;

  constructor(signaller?: TorrentSignaller) {
    this.signaller = signaller ?? new TorrentSignaller({ auto_connect: true });
    this.identifier =
      (this.signaller && this.signaller.identifier) ||
      this.utils.random_string();

    // when the signaller receives signalling messages route them to this instance
    this.signaller.on_message = (m) => this._handle_signal_message(m);
  }

  async connect_to_peer(remote_id: string) {
    // create a new PeerConnection and send an OFFER
    const { pc, dc } = this._create_peer_connection(remote_id, true);

    // create an offer and send it
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const msg: TorrentSignalMessage = {
      type: "OFFER",
      from: this.identifier,
      to: remote_id,
      sdp: offer,
    };
    this.signaller.send(msg);

    return { pc, dc };
  }

  register_remote_binding(seeder_id: string, furrow_id?: string) {
    this.bound_seeders.add(seeder_id);
    if (furrow_id) this.bound_furrows.add(furrow_id);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_BIND",
      peer_id: this.identifier,
      seeder_id,
      furrow_id,
    };

    this._broadcast_control(control);
  }

  unregister_remote_binding(seeder_id: string, furrow_id?: string) {
    this.bound_seeders.delete(seeder_id);
    if (furrow_id) this.bound_furrows.delete(furrow_id);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_UNBIND",
      peer_id: this.identifier,
      seeder_id,
      furrow_id,
    };

    this._broadcast_control(control);
  }

  publish(msg: {
    seeder_id: string;
    furrow_id?: string;
    message?: TorrentMessageObject;
  }) {
    const control: TorrentControlMessage = {
      type: "PUBLISH",
      peer_id: this.identifier,
      seeder_id: msg.seeder_id,
      furrow_id: msg.furrow_id,
      message: msg.message,
    };

    // send to all connected peers via datachannels if available
    for (const [pid, entry] of this.peers.entries()) {
      if (entry.dc && entry.dc.readyState === "open") {
        entry.dc.send(JSON.stringify(control));
      }
    }

    // also handle locally as if received
    this._handle_publish(control);
  }

  close_peer(remote_id: string) {
    const entry = this.peers.get(remote_id);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (e) {}
    this.peers.delete(remote_id);
  }

  find(seeder_name: string, furrow_name?: string) {
    const control: TorrentControlMessage = {
      type: "FIND",
      peer_id: this.identifier,
      seeder_name,
      furrow_name,
    };

    this._find_seeder_or_furrow(control);
  }

  private _create_peer_connection(
    remote_id: string,
    create_dc = false,
  ): TorrentPeerEntry {
    // if existing peer connection exists, return it
    const existing = this.peers.get(remote_id);
    if (existing) return existing;

    const pc = new RTCPeerConnection();
    let dc: RTCDataChannel | undefined;

    // if we expect to create the datachannel locally
    if (create_dc) {
      dc = pc.createDataChannel(this.utils.random_string());
      this._attach_dc_handlers(dc, remote_id);
    }

    // remote may create a datachannel; capture it
    pc.ondatachannel = (ev) => {
      const channel = ev.channel;
      this._attach_dc_handlers(channel, remote_id);
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const cand_msg: TorrentSignalMessage = {
          type: "ICE",
          from: this.identifier,
          to: remote_id,
          candidate: ev.candidate.toJSON(),
        };
        this.signaller.send(cand_msg);
      }
    };

    const entry: TorrentPeerEntry = { pc, dc };
    this.peers.set(remote_id, entry);
    return entry;
  }

  private _attach_dc_handlers(dc: RTCDataChannel, remote_id: string) {
    dc.onopen = () => {
      // announce binds for currently bound seeders when channel opens
      for (const seeder_id of this.bound_seeders) {
        const announce: TorrentControlMessage = {
          type: "ANNOUNCE_BIND",
          peer_id: this.identifier,
          seeder_id,
        };
        try {
          dc.send(JSON.stringify(announce));
        } catch (e) {
          console.warn("failed to send announce", e);
        }
      }
    };

    dc.onmessage = (ev) => {
      try {
        const parsed =
          typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        this._handle_control_message(
          parsed as TorrentControlMessage,
          remote_id,
        );
      } catch (e) {
        console.warn("invalid control message from dc", ev.data);
      }
    };

    // store dc on the peer entry
    const entry = this.peers.get(remote_id);
    if (entry) entry.dc = dc;
  }

  private _handle_signal_message(msg: TorrentSignalMessage) {
    switch (msg.type) {
      case "OFFER":
        return this._handle_offer(msg);
      case "ANSWER":
        return this._handle_answer(msg);
      case "ICE":
        return this._handle_ice(msg);
      case "RELAY_CONTROL":
        return this._handle_control_message(msg.control, msg.from);
      case "FIND":
        return this._handle_control_message(msg.control, msg.from);
    }
  }

  private async _handle_offer(
    msg: Extract<TorrentSignalMessage, { type: "OFFER" }>,
  ) {
    const remote_id = msg.from;
    const { pc } = this._create_peer_connection(remote_id, false);

    // set remote description from the offer
    await pc.setRemoteDescription(msg.sdp);

    // create local datachannel if desired and create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // send answer back
    const resp: TorrentSignalMessage = {
      type: "ANSWER",
      from: this.identifier,
      to: remote_id,
      sdp: answer,
    };
    this.signaller.send(resp);
  }

  private async _handle_answer(
    msg: Extract<TorrentSignalMessage, { type: "ANSWER" }>,
  ) {
    const remote_id = msg.from;
    const entry = this.peers.get(remote_id);
    if (!entry) return;
    await entry.pc.setRemoteDescription(msg.sdp);
  }

  private async _handle_ice(
    msg: Extract<TorrentSignalMessage, { type: "ICE" }>,
  ) {
    const remote_id = msg.from;
    const entry = this.peers.get(remote_id);
    if (!entry) return;

    try {
      await entry.pc.addIceCandidate(msg.candidate);
    } catch (e) {
      console.warn("failed to add remote ice candidate", e);
    }
  }

  private _broadcast_control(control: TorrentControlMessage) {
    // send RELAY_CONTROL via signaller so the signalling server can route it
    const relay: TorrentSignalMessage = {
      type: "RELAY_CONTROL",
      from: this.identifier,
      control,
    };
    try {
      this.signaller.send(relay);
    } catch (e) {
      // fallback: try to send directly over datachannels
      for (const [, entry] of this.peers) {
        if (entry.dc && entry.dc.readyState === "open")
          entry.dc.send(JSON.stringify(control));
      }
    }
  }

  private _handle_control_message(
    control: TorrentControlMessage,
    from_peer_id?: string,
  ) {
    switch (control.type) {
      case "ANNOUNCE_BIND": {
        const set =
          this.remote_bindings.get(control.seeder_id) ?? new Set<string>();
        set.add(control.peer_id);
        this.remote_bindings.set(control.seeder_id, set);
        break;
      }
      case "ANNOUNCE_UNBIND": {
        const set = this.remote_bindings.get(control.seeder_id);
        if (set) {
          set.delete(control.peer_id);
          if (set.size === 0) this.remote_bindings.delete(control.seeder_id);
        }
        break;
      }
      case "PUBLISH": {
        this._handle_publish(control);
        break;
      }
      case "ACK": {
        // TODO: ack handling (deliver to on_ack callbacks)
        break;
      }
      case "FIND": {
        this._search_seeder_or_furrow(control, from_peer_id);
      }
    }
  }

  private _handle_publish(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    // handle routing locally: for each bound furrow/seeder owned by this peer run local callbacks
    // NOTE: The real routing logic will depend on how you map seeder_ids -> local handlers
    // For now we simply construct a TorrentMessage and drop it (user should hook into this class)

    // Example: if message has routing_key and matches this.identifier then accept
    const routing_key = msg.message?.properties?.routing_key ?? "";

    // naive local delivery: if routing_key is empty or equals our identifier then deliver
    if (!routing_key || routing_key === this.identifier) {
      const tmsg = new TorrentMessage(
        msg.seeder_id as any,
        msg.message?.body ?? null,
      );
      tmsg.properties = msg.message?.properties ?? {};
      // user of TorrentPeer should register callbacks to receive tmsg
      // e.g. an event emitter or overrideable method
      this.on_message_received?.(tmsg);
    }
  }

  private _find_seeder_or_furrow(control: TorrentControlMessage) {
    const msg: TorrentSignalMessage = {
      type: "FIND",
      from: this.identifier,
      control,
    };
    try {
      this.signaller.send(msg);
    } catch (e) {
      // fallback: try to send directly over datachannels
      for (const [, entry] of this.peers) {
        if (entry.dc && entry.dc.readyState === "open")
          entry.dc.send(JSON.stringify(msg));
      }
    }
  }

  private _search_seeder_or_furrow(
    control: TorrentControlMessage,
    from_peer_id?: string,
  ) {}

  // overridable hook
  on_message_received?(msg: TorrentMessage): void;
}
