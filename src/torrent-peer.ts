import { TorrentEmitter } from "./torrent-emitter";
import { TorrentLRUCache } from "./torrent-lru";
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

export class TorrentPeer extends TorrentEmitter<TorrentEventName> {
  // map of remote peer id -> TorrentPeerEntry { RTCPeerConnection, RTCDataChannel, TorrentBrokerBindings }
  private peers: Map<string, TorrentPeerEntry> = new Map();
  // map [seeder_id, seeder_name] -> [furrow_id, furrow_name, routing_key][]
  private broker_bindings: TorrentBrokerBindings = new Map();
  // the hosted seeders and or furrows [seeder_name] -> [furrow_name][]
  private hosted: Map<[string], Set<[string]>> = new Map();

  private forwarded_cache = new TorrentLRUCache<string, boolean>(1024);

  private signaller: TorrentSignaller = new TorrentSignaller();
  private utils: TorrentUtils = new TorrentUtils();

  readonly identifier: string = this.utils.random_string();
  readonly is_connected: boolean = false;

  constructor() {
    super();

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
      control_id: this.utils.random_string(),
      peer_id: this.identifier,
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
      peer_id: this.identifier,
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
      on_ack: msg.message?.on_ack,
    };

    const control: TorrentControlMessage = {
      type: "PUBLISH",
      control_id: this.utils.random_string(),
      peer_id: this.identifier,
      seeder: msg.seeder,
      furrow: msg?.furrow,
      message: publish_msg,
    };

    // send to all connected peers via datachannels if available
    this._handle_publish(control);
  }

  close_peer_connection(peer_id: string) {
    const entry = this.peers.get(peer_id);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (e) {}
    this.peers.delete(peer_id);
    this.emit("PEER_DISCONNECTED", { peer_id: peer_id });
  }

  find(
    seeder: TorrentControlSeederOrFurrow,
    furrow?: TorrentControlSeederOrFurrow,
  ) {
    const control: TorrentControlMessage = {
      type: "FIND",
      control_id: this.utils.random_string(),
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

    // if we expect to create the datachannel locally (we are the deterministic offerer)
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
      else {
        // ensure iceQueue and flags exist even if we hadn't created the entry
        this.peers.set(remote_id, {
          pc,
          dc: channel,
        });
        const created = this.peers.get(remote_id)!;
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
        this.emit("PEER_DISCONNECTED", { peer_id: remote_id });
      }
    };

    // create entry and initialize our helper fields
    const entry: TorrentPeerEntry = { pc, dc };
    // attach runtime-only helpers (avoid having to change external types immediately)
    entry.ice_queue = [];
    entry.making_offer = false;
    entry.israp = false;

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
          control_id: this.utils.random_string(),
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
      this.emit("PEER_CONNECTED", { peer_id: remote_id, dc });
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
      this.emit("PEER_DISCONNECTED", { peer_id: remote_id });
      const entry = this.peers.get(remote_id);
      if (entry) entry.dc = undefined;
    };
  }

  private _handle_signal_message(msg: TorrentSignalMessage) {
    // ignore our own messages (except for signaller identify)
    if (msg.type !== "SIGNALLER" && msg.from === this.identifier) return;

    switch (msg.type) {
      case "HELO":
        return this._handle_helo(msg);
      case "HIHI":
        return this._handle_hihi(msg);
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
      default:
        // ignore unknown or control messages coming over websocket - we want control over DC only
        return;
    }
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

  private async _handle_offer(
    msg: Extract<TorrentSignalMessage, { type: "OFFER" }>,
  ) {
    const remote_id = msg.from;
    // only handle offers that are actually for us
    if (msg.to && msg.to !== this.identifier) return;

    // ensure entry exists (we are the non-offerer or we didn't initiate connection)
    let entry = this.peers.get(remote_id);

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
    const entry = this.peers.get(remote_id);

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
    const entry = this.peers.get(remote_id);
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

  private _handle_helo(msg: TorrentSignalMessage) {
    // HELO auto-discovery: when a peer broadcasts HELO we start initiating a connection to them
    if (msg.type === "HELO" && msg.from) {
      const from = msg.from as string;
      if (from === this.identifier) return;
      // if we already have a connection to them, ignore
      if (this.peers.has(from)) return;
      // they might not have discovered this peer so say "HIHI"
      if (msg.from !== this.identifier) {
        const hello_broadcast: TorrentSignalMessage = {
          type: "HIHI",
          from: this.identifier,
          to: msg.from,
        };
        this.signaller.send(hello_broadcast);
      }

      // create pc + dc and send OFFER (deterministic tie-break inside)
      this._initiate_connection_to_peer(from).catch((e) =>
        console.warn("failed to initiate connection", e),
      );
      return;
    }
  }

  private _handle_hihi(msg: TorrentSignalMessage) {
    if (msg.type !== "HIHI") return;
    const from = msg.from;
    if (from === this.identifier) return;
    if (msg.to !== this.identifier) return;
    // initiate connection to the peer that sent HELO_ACK
    this._initiate_connection_to_peer(from);
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

    if (control.type !== "PUBLISH")
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
    else
      // use the weighted k-best forwarding alg
      this._forward_msg(control).then();
  }

  private _handle_control_message(
    control: TorrentControlMessage,
    from_peer_id?: string,
  ) {
    // ensure peer entry has bb map
    const peer = this.peers.get(from_peer_id ?? control.peer_id);
    if (peer && !peer.bb) peer.bb = new Map();

    switch (control.type) {
      case "ANNOUNCE_BIND": {
        if (!peer?.bb) break;
        const seeder_key: [string, string] = [
          control.seeder.id,
          control.seeder.name,
        ];
        let furrow_set = peer.bb.get(seeder_key);

        if (!furrow_set) {
          // If no furrows are bound to this seeder yet, create a new Set
          furrow_set = new Set();
          peer.bb.set(seeder_key, furrow_set);
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
        let furrow_set = peer.bb.get(seeder_key);

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
          peer.bb.delete(seeder_key);
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

  // handle publishing locally (and optionally broadcasting if desired)
  private _handle_publish(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    // We broadcast PUBLISH to other peers if we receive a local publish that should be relayed.
    // But to avoid loops, PUBLISH arriving over DC should be handled by _handle_receive (not this function).
    // When called for a local origin, broadcast to peers (DCs only)
    this._broadcast_control(msg);
    this.emit("PUBLISH", msg);
  }

  private _handle_receive(
    msg: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    // ignore if message from self
    if (msg.peer_id === this.identifier) return;

    // already processed, skip entirely
    if (this.forwarded_cache.has(msg.control_id)) return;
    this.forwarded_cache.set(msg.control_id, true);

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

  private async _forward_msg(
    control: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    const id = control.control_id;
    if (!id) return;
    if (this.forwarded_cache.has(id)) return;
    this.forwarded_cache.set(id, true);

    this._calculate_candidates(control).then(
      (res: { best: { peer_id: string; cost: number }[]; rest: string[] }) => {
        if (res.best.length <= 0 && res.rest.length <= 0) return;
        for (const { peer_id } of res.best) {
          const entry = this.peers.get(peer_id);
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
              remaining_targets: res.rest,
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
    candidates: { peer_id: string; cost: number }[],
    k: number,
  ) {
    const best = candidates.slice(0, k);
    const rest = candidates.slice(k);
    return { best, rest: rest.map((x) => x.peer_id) };
  }

  // TODO: A* algorithm for advanced routing
  // get the stats for the peer connections
  // choose the best peer based on latency, bandwidth, etc.
  // It seems that A* makes no sense for this.
  // Will be pivoting to Weighted K-Best Forwarding (W-KBF)
  private async _calculate_candidates(
    control: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ): Promise<{
    best: { peer_id: string; cost: number }[];
    rest: string[];
  }> {
    const seen = new Set<string>();
    const candidates: Array<{ peer_id: string; cost: number }> = [];
    const { seeder, furrow, peer_id: control_peer_id } = control;
    const targets = control.remaining_targets;
    let peers = this.peers;

    if (targets && targets?.length > 0) {
      // Create a filtered array of [key, peer] pairs
      const filtered_entries = targets
        .map((key) => {
          const peer = this.peers.get(key);
          return peer ? [key, peer] : null; // If peer exists, return [key, peer], otherwise return null
        })
        .filter((entry) => entry !== null) as [string, TorrentPeerEntry][]; // Rebuild the Map from the filtered entries

      peers = new Map(filtered_entries);
    }

    for (const [peer_id, entry] of peers) {
      // Skip if the peer_id is the same as the control peer_id (the sender)
      if (peer_id === control_peer_id) continue;
      if (peer_id === this.identifier) continue;

      const pc = entry?.pc;
      const stats = await pc?.getStats?.();
      let min_cost = Infinity;

      if (stats) {
        stats.forEach((report) => {
          if (
            report.type === "candidate-pair" &&
            report.state === "succeeded"
          ) {
            // Defensive: avoid division by zero
            const packetsReceived = report.packetsReceived || 1;
            const cost =
              0.7 * (report.currentRoundTripTime ?? 0) +
              0.3 * ((report.totalRoundTripTime ?? 0) / packetsReceived);
            min_cost = Math.min(min_cost, cost);
          }
        });
        entry.cost = min_cost !== Infinity ? min_cost : entry.cost;
      }

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
          candidates.push({ peer_id, cost: entry.cost ?? Infinity });
          seen.add(peer_id);
        }
      }
    }

    const k_max = Math.ceil(Math.sqrt(candidates.length));
    const k = Math.min(k_max, candidates.length);

    candidates.sort((a, b) => a.cost - b.cost);
    return this._split_candidates(candidates, k);
  }

  // TODO: implement load balancing for sharing seeders
  // multiple peers hosting the same seeder but only part of it e.g. one furrow
  private async _load_balance_control() {}
}
