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
  // map of remote peer id -> TorrentPeerEntry { RTCPeerConnection, RTCDataChannel, TorrentBrokerBindings }
  private peers: Map<string, TorrentPeerEntry> = new Map();
  // map [seeder_id, seeder_name] -> [furrow_id, furrow_name, routing_key][]
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
        } catch (e) {
          console.warn("failed to send hello via signaller", e);
        }
      })
      .catch((err) => {
        console.warn("signaller connect failed", err);
      });
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
    this._handle_publish(control);
  }

  close_peer(remote_id: string) {
    const entry = this.peers.get(remote_id);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (e) {}
    this.peers.delete(remote_id);
    this._emit("PEER_DISCONNECTED", { peer_id: remote_id });
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

    this._broadcast_control(control);
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

    // if we expect to create the datachannel locally (we are the offerer)
    if (create_dc) {
      dc = pc.createDataChannel(this.utils.random_string());
      this._attach_dc_handlers(dc, remote_id);
    }

    // remote may create a datachannel; capture it
    pc.ondatachannel = (ev) => {
      const channel = ev.channel;
      this._attach_dc_handlers(channel, remote_id);

      // store dc
      const e = this.peers.get(remote_id);
      if (e) e.dc = channel;
      else this.peers.set(remote_id, { pc, dc: channel });
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
        this._emit("PEER_DISCONNECTED", { peer_id: remote_id });
      }
    };

    const entry: TorrentPeerEntry = { pc, dc };
    this.peers.set(remote_id, entry);
    return entry;
  }

  private _attach_dc_handlers(dc: RTCDataChannel, remote_id: string) {
    dc.onopen = () => {
      // store dc on the peer entry (defensive)
      const entry = this.peers.get(remote_id);
      if (entry) entry.dc = dc;

      // announce binds for currently bound seeders when channel opens
      for (const [seeder, furrow_set] of this.broker_bindings) {
        const [seeder_id, seeder_name] = seeder;

        const announce: TorrentControlMessage = {
          type: "ANNOUNCE_BIND",
          peer_id: this.identifier,
          seeder: { id: seeder_id, name: seeder_name },
        };

        if (furrow_set.size > 0) {
          for (const [furrow_id, furrow_name, furrow_rkey] of furrow_set) {
            const announce_with_furrow: TorrentControlMessage = {
              ...announce,
              furrow: {
                id: furrow_id,
                name: furrow_name,
                routing_key: furrow_rkey,
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
      this._emit("PEER_CONNECTED", { peer_id: remote_id, dc });
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

    dc.onclose = () => {
      this._emit("PEER_DISCONNECTED", { peer_id: remote_id });
      const entry = this.peers.get(remote_id);
      if (entry) entry.dc = undefined;
    };
  }

  private _handle_signal_message(msg: TorrentSignalMessage) {
    // ignore our own messages (except for signaller identify)
    if (
      (msg.type !== "SIGNALLER" && (msg as any).from === this.identifier) ||
      (msg as any).identifier === this.identifier
    )
      return;

    // HELO auto-discovery: when a peer broadcasts HELO we start initiating a connection to them
    // Accept both a custom HELO shape and generic SIGNALLER ident messages (backwards compatibility)
    if ((msg as any).type === "HELO" && (msg as any).from) {
      const from = (msg as any).from as string;
      if (from === this.identifier) return;
      // if we already have a connection to them, ignore
      if (this.peers.has(from)) return;
      // create pc + dc and send OFFER
      this._initiate_connection_to_peer(from).catch((e) =>
        console.warn("failed to initiate connection", e),
      );
      return;
    }

    switch (msg.type) {
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
      case "SIGNALLER":
        // server identity; ignore or handle if needed
        return;
      default:
        // ignore unknown or control messages coming over websocket - we want control over DC only
        return;
    }
  }

  private async _initiate_connection_to_peer(remote_id: string) {
    // create pc and datachannel and send OFFER through signaller
    const { pc } = this._create_peer_connection(remote_id, true);

    // create an offer and send it
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
  }

  private async _handle_offer(
    msg: Extract<TorrentSignalMessage, { type: "OFFER" }>,
  ) {
    const remote_id = msg.from;
    // only handle offers that are actually for us
    if ((msg as any).to && (msg as any).to !== this.identifier) return;

    let entry = this.peers.get(remote_id);

    if (!entry) {
      entry = this._create_peer_connection(remote_id, false);
    }

    const pc = entry.pc;

    // negotiation: handle glare
    if (pc.signalingState !== "stable") {
      try {
        await pc.setLocalDescription({ type: "rollback" } as any);
      } catch (e) {
        // some browsers require guard here
        console.warn("rollback failed", e);
      }
    }

    // set remote description from the offer
    await pc.setRemoteDescription(msg.sdp);

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
  }

  private async _handle_answer(
    msg: Extract<TorrentSignalMessage, { type: "ANSWER" }>,
  ) {
    const remote_id = msg.from;
    const entry = this.peers.get(remote_id);

    if (!entry) return;

    try {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription(msg.sdp);
      }
    } catch (e) {
      console.warn("failed to apply remote answer", e);
    }
  }

  private async _handle_ice(
    msg: Extract<TorrentSignalMessage, { type: "ICE" }>,
  ) {
    const remote_id = msg.from;
    const entry = this.peers.get(remote_id);
    if (!entry) return;

    try {
      // accept candidate only if pc exists
      await entry.pc.addIceCandidate(msg.candidate);
    } catch (e) {
      console.warn("failed to add remote ice candidate", e);
    }
  }

  // Move all control traffic to DCs only. WebSocket signaling is used only for HELO/OFFER/ANSWER/ICE.
  private _broadcast_control(
    control: TorrentControlMessage,
    to_peer_id?: string,
  ) {
    // if a target peer_id is given, send only to that peer (if open)
    if (to_peer_id) {
      const targeted = this.peers.get(to_peer_id);
      if (targeted?.dc && targeted.dc.readyState === "open") {
        try {
          targeted.dc.send(JSON.stringify(control));
        } catch (e) {
          console.warn("failed to send control to target peer", e);
        }
      }
      return;
    }

    // otherwise broadcast to all connected peers over DCs only
    for (const [, entry] of this.peers) {
      if (entry.dc && entry.dc.readyState === "open") {
        try {
          entry.dc.send(JSON.stringify(control));
        } catch (e) {
          console.warn("failed to broadcast control to peer", e);
        }
      }
    }
  }

  private _handle_control_message(
    control: TorrentControlMessage,
    from_peer_id?: string,
  ) {
    // ensure peer entry has bd map
    const peer = this.peers.get(from_peer_id ?? control.peer_id);
    if (peer && !peer.bd) peer.bd = new Map();

    switch (control.type) {
      case "ANNOUNCE_BIND": {
        if (!peer?.bd) break;
        const seeder_key: [string, string] = [
          control.seeder.id,
          control.seeder.name,
        ];
        let furrow_set = peer.bd.get(seeder_key);

        if (!furrow_set) {
          // If no furrows are bound to this seeder yet, create a new Set
          furrow_set = new Set();
          peer.bd.set(seeder_key, furrow_set);
        }

        // If a furrow is provided, add the furrow to the set for this seeder
        if (control.furrow?.id && control.furrow?.name) {
          const furrowKey: [string, string, string] = [
            control.furrow.id,
            control.furrow.name,
            control.furrow.routing_key ?? from_peer_id ?? control.peer_id,
          ];
          furrow_set.add(furrowKey);
        }

        this._emit("PEER_BIND", {
          seeder: control.seeder,
          furrow: control.furrow,
          peer_id: from_peer_id,
        });
        break;
      }

      case "ANNOUNCE_UNBIND": {
        if (!peer?.bd) break;
        const seeder_key: [string, string] = [
          control.seeder.id,
          control.seeder.name,
        ];
        let furrow_set = peer.bd.get(seeder_key);

        if (!furrow_set && control.furrow) break;
        if (control.furrow?.id && control.furrow?.name) {
          const furrowKey: [string, string, string] = [
            control.furrow.id,
            control.furrow.name,
            control.furrow.routing_key ?? from_peer_id ?? control.peer_id,
          ];
          // Remove furrow
          furrow_set?.delete(furrowKey);
        }
        if (!control.furrow) {
          // Remove seeder
          peer.bd.delete(seeder_key);
        }

        this._emit("PEER_UNBIND", {
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
        this._emit("ACK", {
          message_id: (control as any).message_id,
          peer_id: from_peer_id,
        });
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
          peer_id: from_peer_id,
        });
        // replace the local binding with the remote authoritative seeder
        this.register_remote_binding(control.seeder, control?.furrow);
        break;
      }

      case "NOT_FOUND": {
        this._emit("NOT_FOUND", { seeder: control.seeder });
        break;
      }
    }
  }

  // handle publishing locally (and optionally broadcasting if desired)
  private _handle_publish(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    // We broadcast PUBLISH to other peers if we receive a local publish that should be relayed.
    // But to avoid loops, PUBLISH arriving over DC should be handled by _handle_receive (not this function).
    // When called for a local origin, broadcast to peers (DCs only)
    this._broadcast_control(msg);
    this._emit("PUBLISH", msg);
  }

  private _handle_receive(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    // Local routing: accept message if routing_key matches this.identifier or empty
    const routing_key = msg.message?.properties?.routing_key ?? "";

    if (!routing_key || routing_key === this.identifier) {
      const tmsg = new TorrentMessage(msg.message?.body ?? null);
      tmsg.properties = msg.message?.properties ?? {};
      // let user handle it
      this._emit("MESSAGE_RECEIVE", msg);
    }

    // Additionally, match against local broker_bindings (furrow-level routing)
    let furrow;
    for (const [seeder_entry, furrow_set] of this.broker_bindings) {
      const [, real_seeder_name] = seeder_entry;
      if (real_seeder_name !== msg.seeder.name) continue;

      if (msg?.furrow) {
        const req_furrow_name = msg.furrow.name;
        for (const [
          real_furrow_id,
          real_furrow_name,
          furrow_routing_key,
        ] of furrow_set) {
          if (
            real_furrow_name === req_furrow_name &&
            routing_key === furrow_routing_key
          ) {
            furrow = { id: real_furrow_id, name: real_furrow_name };
          }
        }
      }
    }

    if (msg?.furrow && furrow) this._emit("MESSAGE_RECEIVE", msg);
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
    let furrow_set = this.broker_bindings.get(seeder_key);

    if (!furrow_set) {
      furrow_set = new Set();
      this.broker_bindings.set(seeder_key, furrow_set);
    }

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
    const seeder_key: [string, string] = [seeder.id, seeder.name];
    let furrow_set = this.broker_bindings.get(seeder_key);

    if (!furrow_set && furrow) return;
    if (furrow?.id && furrow?.name) {
      const furrowKey: [string, string, string] = [
        furrow.id,
        furrow.name,
        furrow.routing_key ?? this.identifier,
      ];
      furrow_set?.delete(furrowKey);
      return;
    }
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
