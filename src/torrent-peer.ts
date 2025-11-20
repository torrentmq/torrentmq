import { TorrentError } from "./torrent-error";
import { TorrentMessage } from "./torrent-message";
import { TorrentSignaller } from "./torrent-signaller";
import {
  TorrentControlMessage,
  TorrentMessageObject,
  TorrentPeerEntry,
  TorrentSignalMessage,
  TorrentControlSeederOrFurrow,
  TorrentEventName,
  TorrentBrokerBindings,
  TorrentControlBindFurrow,
} from "./torrent-types";
import { TorrentUtils } from "./torrent-utils";

export class TorrentPeer {
  // seeder_id -> set of peer_ids that reported they are bound to that seeder
  remote_bindings: Map<string, Set<string>> = new Map();

  // map of remote peer id -> PeerEntry
  private peers: Map<string, TorrentPeerEntry> = new Map();
  // map [seeder_id, seeder_name] -> [furrow_id, furrow_name][]
  private broker_bindings: TorrentBrokerBindings = new Map();
  // map emittable events to a set of function
  private _events: Map<TorrentEventName, Set<(data: any) => void>> = new Map();

  private signaller: TorrentSignaller;
  private utils: TorrentUtils = new TorrentUtils();

  readonly identifier: string;

  constructor(signaller?: TorrentSignaller) {
    this.signaller = signaller ?? new TorrentSignaller();
    this.identifier =
      (this.signaller && this.signaller.identifier) ||
      this.utils.random_string();

    // when the signaller receives signalling messages route them to this instance
    this.signaller.on_message = (m) => this._handle_signal_message(m);
  }

  async connect_to_peer() {
    // create a new PeerConnection and send an OFFER
    const { pc, dc } = this._create_peer_connection(this.identifier, true);
    this._emit("PEER_CONNECTED", { pc, dc });

    await this.signaller.connect();

    // create an offer and send ikkt
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const msg: TorrentSignalMessage = {
      type: "OFFER",
      from: this.identifier,
      to: this.identifier,
      sdp: offer,
    };
    this.signaller.send(msg);

    return { pc, dc };
  }

  register_remote_binding(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    this._bind_seeder_or_furrow(seeder, furrow);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_BIND",
      peer_id: this.identifier,
      seeder,
      furrow,
    };

    this._emit("BIND", { seeder, furrow });
    this._broadcast_control(control);
  }

  unregister_remote_binding(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    this._unbind_seeder_or_furrow(seeder, furrow);

    const control: TorrentControlMessage = {
      type: "ANNOUNCE_UNBIND",
      peer_id: this.identifier,
      seeder,
      furrow,
    };

    this._emit("UNBIND", { seeder, furrow });
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
      on_ack: msg.message?.on_ack,
    };

    const control: TorrentControlMessage = {
      type: "PUBLISH",
      peer_id: this.identifier,
      seeder: msg.seeder,
      furrow: msg?.furrow,
      message: publish_msg,
    };

    // send to all connected peers via datachannels if available
    for (const [, entry] of this.peers.entries()) {
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

  on(
    event:
      | TorrentEventName
      | Partial<Record<TorrentEventName, (payload: any) => void>>,
    handler?: (payload: any) => void,
  ) {
    if (typeof event === "object") {
      for (const [evt, fn] of Object.entries(event)) {
        this.on(evt as TorrentEventName, fn);
      }
      return;
    }

    if (!handler) {
      throw new TorrentError("Handler must be provided for on(event, handler)");
    }

    if (!this._events.has(event)) {
      this._events.set(event, new Set());
    }

    this._events.get(event)!.add(handler);
  }

  find(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    const control: TorrentControlMessage = {
      type: "FIND",
      peer_id: this.identifier,
      seeder,
      furrow,
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
      for (const [seeder, furrow_set] of this.broker_bindings) {
        const [seeder_id, seeder_name] = seeder;

        const announce: TorrentControlMessage = {
          type: "ANNOUNCE_BIND",
          peer_id: this.identifier,
          seeder: { id: seeder_id, name: seeder_name },
        };

        if (furrow_set.size > 0) {
          for (const [furrow_id, furrow_name] of furrow_set) {
            const announceWithFurrow = {
              ...announce,
              furrow: { id: furrow_id, name: furrow_name },
            };
            try {
              dc.send(JSON.stringify(announceWithFurrow));
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

  private _broadcast_control(
    control: TorrentControlMessage,
    to_peer_id?: string,
  ) {
    // send RELAY_CONTROL via signaller so the signalling server can route it
    const relay: TorrentSignalMessage = {
      type: "RELAY_CONTROL",
      from: this.identifier,
      to: to_peer_id,
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
          this.remote_bindings.get(control.seeder.id) ?? new Set<string>();
        set.add(control.peer_id);
        this.remote_bindings.set(control.seeder.id, set);
        this._emit("PEER_BIND", {
          seeder: control.seeder,
          furrow: control.furrow,
        });
        break;
      }
      case "ANNOUNCE_UNBIND": {
        const set = this.remote_bindings.get(control.seeder.id);
        if (set) {
          set.delete(control.peer_id);
          if (set.size === 0) this.remote_bindings.delete(control.seeder.id);
        }
        this._emit("PEER_UNBIND", {
          seeder: control.seeder,
          furrow: control.furrow,
        });
        break;
      }
      case "PUBLISH": {
        this._handle_publish(control, true);
        break;
      }
      case "ACK": {
        // TODO: ack handling (deliver to on_ack callbacks)
        break;
      }
      case "FIND": {
        this._search_seeder_or_furrow(control, from_peer_id);
        break;
      }
      case "FOUND": {
        this._emit("FOUND", {
          seeder: control.seeder,
          furrow: control?.furrow,
        });
        this.register_remote_binding(control.seeder, control?.furrow);
        break;
      }
    }
  }

  // TODO: fix _handle_publish to send to external peers
  private _handle_publish(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
    is_receiving: boolean = false,
  ) {
    // handle routing locally: for each bound furrow/seeder owned by this peer run local callbacks
    // NOTE: The real routing logic will depend on how you map seeder_ids -> local handlers
    // For now we simply construct a TorrentMessage and drop it (user should hook into this class)

    // Example: if message has routing_key and matches this.identifier then accept
    const routing_key = msg.message?.properties?.routing_key ?? "";

    if (!is_receiving) this._broadcast_control(msg);

    // naive local delivery: if routing_key is empty or equals our identifier then deliver
    if (!routing_key || routing_key === this.identifier) {
      const tmsg = new TorrentMessage(msg.message?.body ?? null);
      tmsg.properties = msg.message?.properties ?? {};
      // user of TorrentPeer should register callbacks to receive tmsg
      // e.g. an event emitter or overrideable method
      this._emit(is_receiving ? "MESSAGE_RECEIVE" : "PUBLISH", msg);
    }
  }

  private _find_seeder_or_furrow(control: TorrentControlMessage) {
    const msg: TorrentSignalMessage = {
      type: "RELAY_CONTROL",
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
  ) {
    if (control.type !== "FIND") return;

    const fnd_msg: TorrentControlMessage = {
      type: "FOUND",
      peer_id: this.identifier,
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

    this._broadcast_control(fnd_msg, from_peer_id);
  }

  private _bind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    // Check if the seeder already has an entry in the map
    const seeder_key: [string, string] = [seeder.id, seeder.name];
    let furrow_set = this.broker_bindings.get(seeder_key);

    if (!furrow_set) {
      // If no furrows are bound to this seeder yet, create a new Set
      furrow_set = new Set();
      this.broker_bindings.set(seeder_key, furrow_set);
    }

    // If a furrow is provided, add the furrow to the set for this seeder
    if (furrow?.id && furrow?.name) {
      const furrowKey: [string, string, string] = [
        furrow.id,
        furrow.name,
        furrow.routing_key ?? this.identifier,
      ];
      furrow_set.add(furrowKey);
    }
  }

  private _unbind_seeder_or_furrow(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlBindFurrow,
  ) {
    // Check if the seeder already has an entry in the map
    const seeder_key: [string, string] = [seeder.id, seeder.name];
    let furrow_set = this.broker_bindings.get(seeder_key);

    if (!furrow_set && furrow) return;
    if (furrow?.id && furrow?.name) {
      const furrowKey: [string, string, string] = [
        furrow.id,
        furrow.name,
        furrow.routing_key ?? this.identifier,
      ];
      // Remove furrow
      furrow_set?.delete(furrowKey);
      return;
    }
    //Remove seeder
    this.broker_bindings.delete(seeder_key);
  }

  private _emit(event: TorrentEventName, payload: any) {
    const handlers = this._events.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(payload);
      } catch (err) {
        console.warn("Error in event handler for", event, err);
      }
    }
  }
}
