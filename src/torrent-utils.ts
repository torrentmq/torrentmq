import { TorrentFurrow } from "./torrent-furrow";
import { TorrentPeer } from "./torrent-peer";
import { TorrentSeeder } from "./torrent-seeder";
import {
  TorrentFurrowParams,
  TorrentMessageParams,
  TorrentSeederParams,
} from "./torrent-types";

export class TorrentUtils {
  constructor() {}

  random_string(minLength = 8, maxLength = 16) {
    const charset =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_-+=<>?";

    const length =
      Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;

    const array = new Uint8Array(length);
    window.crypto.getRandomValues(array);

    return Array.from(array)
      .map((byte) => charset[byte % charset.length])
      .join("");
  }

  clone() {}

  is_message_params(arg: unknown): arg is TorrentMessageParams {
    return (
      arg !== null &&
      typeof arg === "object" &&
      ("routing_key" in arg || "on_ack" in arg)
    );
  }

  is_seeder_params(arg: unknown): arg is TorrentSeederParams {
    return (
      arg !== null &&
      typeof arg === "object" &&
      ("type" in arg ||
        "internal" in arg ||
        "args" in arg ||
        "passive" in arg ||
        "durable" in arg ||
        "auto_delete" in arg ||
        "auto_plant" in arg)
    );
  }

  is_furrow_params(arg: unknown): arg is TorrentFurrowParams {
    return (
      arg !== null &&
      typeof arg === "object" &&
      ("auto_bind" in arg ||
        "exclusive" in arg ||
        "passive" in arg ||
        "durable" in arg ||
        "auto_delete" in arg ||
        "auto_plant" in arg)
    );
  }

  is_peer(arg: unknown): arg is TorrentPeer {
    return arg !== null && arg instanceof TorrentPeer;
  }

  is_seeder(arg: unknown): arg is TorrentSeeder {
    return arg !== null && arg instanceof TorrentSeeder;
  }

  is_furrow(arg: unknown): arg is TorrentFurrow {
    return arg !== null && arg instanceof TorrentFurrow;
  }

  rendezvous_hash(key: string, nodes: string[], count = 1): string[] {
    if (!nodes || nodes.length === 0) return [];
    const scores = nodes.map((n) => {
      // deterministic pseudo-random + key combination
      const hashInput = `${n}:${key}`;
      // simple 32-bit hash (FNV-1a variant)
      let h = 2166136261 >>> 0;
      for (let i = 0; i < hashInput.length; i++) {
        h ^= hashInput.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return { node: n, score: h };
    });
    scores.sort((a, b) => b.score - a.score); // high to low
    return scores.slice(0, Math.min(count, scores.length)).map((s) => s.node);
  }
}
