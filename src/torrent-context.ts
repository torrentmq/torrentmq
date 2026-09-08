import { TorrentUtils } from "./torrent-utils";
import {
  TorrentControlMessage,
  TorrentSignalMessage,
  TorrentPeerEntry,
} from "./torrent-types";
import { TorrentLRUCache } from "./torrent-lru";
import { TorrentIdentity } from "./torrent-identity";

export class TorrentContext {
  // this is used to sign every message leaving the peer
  // it acts as the peer's root identity but not identifier
  // why just the one? no clue just  accept it
  protected identity!: TorrentIdentity;
  // well that won't do welcome back
  private _identifier!: string;

  // map of remote peer id -> TorrentPeerEntry { RTCPeerConnection, RTCDataChannel }
  readonly connected_peers: Map<string, TorrentPeerEntry> = new Map();
  protected store: TorrentLRUCache<
    string,
    TorrentControlMessage | TorrentSignalMessage
  >;

  constructor(size?: number) {
    this.store = new TorrentLRUCache<
      string,
      TorrentControlMessage | TorrentSignalMessage
    >(size ?? 1024);

    this._initialize().then();
  }

  get identifier(): string {
    return this._identifier;
  }

  private async _initialize(): Promise<void> {
    this.identity = await TorrentIdentity.create();
    this._identifier = await this.identity.get_identifier();
  }

  has(identifier: string): boolean {
    return this.connected_peers.has(identifier);
  }

  get(identifier: string): TorrentPeerEntry | undefined {
    return this.connected_peers.get(identifier);
  }

  set(identifier: string, entry: TorrentPeerEntry): void {
    this.connected_peers.set(identifier, entry);
  }

  delete(identifier: string): void {
    this.connected_peers.delete(identifier);
  }

  async publish(
    control: Omit<TorrentControlMessage, "control_id" | "artifacts">,
  ) {
    const control_w_artifacts = await this._add_message_artifacts(control);
    if (control_w_artifacts.type === "PUBLISH")
      // use the weighted k-best forwarding alg
      this._forward_msg(control_w_artifacts);
    else
      // otherwise broadcast to all connected peers over DCs only
      for (const [, entry] of this.connected_peers) {
        if (entry.dc && entry.dc.readyState === "open") {
          try {
            entry.dc.send(JSON.stringify(control_w_artifacts));
          } catch (e) {}
        }
      }

    if (!this.store.has(control_w_artifacts.control_id))
      this.store.set(control_w_artifacts.control_id, control_w_artifacts);
  }

  private _forward_msg(
    control: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ) {
    if (this.store.has(control.control_id)) return;
    for (const { peer_id } of this._calculate_best_candidates()) {
      const entry = this.connected_peers.get(peer_id);
      if (!entry?.dc) continue;
      if (entry.dc && entry.dc.readyState === "open")
        try {
          entry.dc.send(JSON.stringify(this._increment_hop_count(control)));
        } catch (e) {}
    }
  }

  private _calculate_best_candidates() {
    // NOTE: stop assaulting this fucking code pls
    // I DON'T THINK SO BUDDY
    const active_peers = Array.from(this.connected_peers.entries()).filter(
      ([, entry]) => entry?.dc && entry.dc.readyState === "open",
    );
    const candidates: Array<{ peer_id: string; ema: number }> =
      active_peers.map(([peer_id, entry]) => ({
        peer_id,
        ema: entry?.stats?.distance ?? Infinity,
      }));

    if (candidates.length === 0) return [];

    const k_max = Math.ceil(Math.sqrt(candidates.length));
    const k = Math.max(1, Math.min(k_max, candidates.length)); // ensure the value of k is at least 1

    const known_stats = candidates.filter((c) => c.ema !== Infinity);
    const unknown_stats = candidates.filter((c) => c.ema === Infinity);

    if (known_stats.length > 0) {
      // sort by EMA ie lowest distance first
      known_stats.sort((a, b) => a.ema - b.ema);

      if (known_stats.length >= k) return known_stats.slice(0, k);
    }

    // if not enough known stats, mix an random unknown peers
    const shuffled_unknown = unknown_stats.sort(() => Math.random() - 0.5);
    const combined = [...known_stats, ...shuffled_unknown];
    return combined.slice(0, k);
  }

  private _increment_hop_count(
    control: Extract<TorrentControlMessage, { type: "PUBLISH" }>,
  ): Extract<TorrentControlMessage, { type: "PUBLISH" }> {
    return {
      ...control,
      ...(control?.message
        ? {
            message: {
              ...control.message,
              properties: {
                ...control.message?.properties,
                headers: {
                  ...control.message?.properties?.headers,
                  hop_count:
                    (control.message?.properties?.headers?.hop_count ?? 0) + 1,
                },
              },
            },
          }
        : {}),
    };
  }

  private async _add_message_artifacts(
    control: Omit<TorrentControlMessage, "control_id" | "artifacts">,
  ): Promise<TorrentControlMessage> {
    // "Wash" the message to remove undefineds and normalize types
    const cleaned_control = JSON.parse(JSON.stringify(control));
    const msg_bytes = TorrentUtils.to_array_buffer(cleaned_control);
    const signature = await this.identity.sign(msg_bytes);
    const pub_key = await this.identity.export_public_key();

    return {
      ...cleaned_control,
      control_id: TorrentUtils.random_string(),
      artifacts: {
        pub_key,
        signature,
        timestamp: Date.now(),
      },
    } as TorrentControlMessage;
  }
}
