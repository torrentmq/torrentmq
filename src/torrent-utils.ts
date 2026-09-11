import type {
  Node,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentPeerQuality,
  TorrentControlMessage,
} from "./torrent-types";
import { TorrentError } from "./torrent-error";

export class TorrentUtils {
  private static encoder = new TextEncoder();
  private static decoder = new TextDecoder();

  constructor() {}

  static random_string({
    min_length = 8,
    max_length = 16,
  }: {
    min_length?: number;
    max_length?: number;
  } = {}) {
    const charset =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_-+=<>?";

    const length =
      Math.floor(Math.random() * (max_length - min_length + 1)) + min_length;

    const array = new Uint8Array(length);
    window.crypto.getRandomValues(array);

    return Array.from(array)
      .map((byte) => charset[byte % charset.length])
      .join("");
  }

  static is_message_params(arg: unknown): arg is TorrentMessageParams {
    return (
      arg !== null &&
      typeof arg === "object" &&
      ("routing_key" in arg || "on_ack" in arg)
    );
  }

  static is_control_message(obj: any): obj is TorrentControlMessage {
    return (
      obj &&
      typeof obj.control_id === "string" &&
      typeof obj.from === "string" &&
      typeof obj.type === "string"
    );
  }

  static buffer_to_base64(buffer: ArrayBuffer): string {
    const binary = new Uint8Array(buffer).reduce(
      (data, byte) => data + String.fromCharCode(byte),
      "",
    );
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  static base64_to_buffer(base64: string): ArrayBuffer {
    const binary_string = atob(
      base64
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="),
    );

    const bytes = new Uint8Array(binary_string.length);
    for (let i = 0; i < binary_string.length; i++) {
      bytes[i] = binary_string.charCodeAt(i);
    }

    return bytes.buffer;
  }

  static to_array_buffer(value: unknown): ArrayBuffer {
    const seen = new Map<unknown, number>();
    let id = 0;

    function encode(val: unknown): Node {
      if (val === null) return { t: "null" };

      const type = typeof val;

      if (type === "number") {
        if (Number.isNaN(val)) return { t: "nan" };
        if (val === Infinity) return { t: "inf" };
        if (val === -Infinity) return { t: "-inf" };
        return { t: "num", v: val as number };
      }

      if (type === "string") return { t: "str", v: val as string };
      if (type === "boolean") return { t: "bool", v: val as boolean };
      if (type === "undefined") return { t: "undef" };
      if (type === "bigint")
        return { t: "bigint", v: (val as bigint).toString() };

      if (type === "object") {
        if (seen.has(val)) return { t: "ref", v: seen.get(val)! };
        const ref_id = id++;
        seen.set(val, ref_id);

        if (val instanceof Date)
          return { t: "date", v: val.toISOString(), id: ref_id };
        if (val instanceof RegExp)
          return { t: "regex", v: [val.source, val.flags], id: ref_id };
        if (val instanceof Map) {
          const entries = Array.from(val.entries()).sort((a, b) => {
            return String(a[0]).localeCompare(String(b[0]));
          });

          return {
            t: "map",
            v: entries.map(([k, v]) => [encode(k), encode(v)]),
            id: ref_id,
          };
        }
        if (val instanceof Set) {
          const sorted_values = Array.from(val).sort().map(encode);
          return { t: "set", v: sorted_values, id: ref_id };
        }
        if (ArrayBuffer.isView(val))
          return {
            t: "typed",
            c: val.constructor.name,
            v: Array.from(val as unknown as ArrayLike<number>),
            id: ref_id,
          };
        if (val instanceof ArrayBuffer)
          return {
            t: "arraybuffer",
            v: Array.from(new Uint8Array(val)),
            id: ref_id,
          };
        if (Array.isArray(val))
          return { t: "arr", v: val.map(encode), id: ref_id };

        const obj: Record<string, Node> = {};
        const sorted_keys = Object.keys(val as object).sort();
        for (const k of sorted_keys)
          obj[k] = encode((val as Record<string, unknown>)[k]);
        return { t: "obj", v: obj, id: ref_id };
      }

      throw new TorrentError("Unsupported type: " + type);
    }

    const json = JSON.stringify(encode(value));
    return this.encoder.encode(json).buffer;
  }

  static from_array_buffer<T = unknown>(buffer: ArrayBuffer): T {
    const json = this.decoder.decode(new Uint8Array(buffer));
    const data = JSON.parse(json) as Node;

    const refs = new Map<number, unknown>();

    function decode(node: Node): unknown {
      switch (node.t) {
        case "null":
          return null;
        case "num":
          return node.v;
        case "str":
          return node.v;
        case "bool":
          return node.v;
        case "undef":
          return undefined;
        case "nan":
          return NaN;
        case "inf":
          return Infinity;
        case "-inf":
          return -Infinity;
        case "bigint":
          return BigInt(node.v);
        case "ref":
          return refs.get(node.v);
        case "date": {
          const d = new Date(node.v);
          refs.set(node.id, d);
          return d;
        }
        case "regex": {
          const r = new RegExp(node.v[0], node.v[1]);
          refs.set(node.id, r);
          return r;
        }
        case "map": {
          const m = new Map<unknown, unknown>();
          refs.set(node.id, m);
          node.v.forEach(([k, v]) => m.set(decode(k), decode(v)));
          return m;
        }
        case "set": {
          const s = new Set<unknown>();
          refs.set(node.id, s);
          node.v.forEach((v) => s.add(decode(v)));
          return s;
        }
        case "typed": {
          const arr = new (globalThis as Record<string, any>)[node.c](node.v);
          refs.set(node.id, arr);
          return arr;
        }
        case "arraybuffer": {
          const buf = new Uint8Array(node.v).buffer;
          refs.set(node.id, buf);
          return buf;
        }
        case "arr": {
          const a: unknown[] = [];
          refs.set(node.id, a);
          node.v.forEach((v) => a.push(decode(v)));
          return a;
        }
        case "obj": {
          const o: Record<string, unknown> = {};
          refs.set(node.id, o);
          for (const k in node.v) o[k] = decode(node.v[k]);
          return o;
        }
      }
    }

    return decode(data) as T;
  }

  static compute_body_size(body: TorrentMessageBody): number {
    if (body === null) return 0;
    if (body instanceof Uint8Array) return body.byteLength;
    switch (typeof body) {
      case "string":
        return this.encoder.encode(body).byteLength;
      case "number":
      case "boolean":
      case "object":
        return this.encoder.encode(JSON.stringify(body)).byteLength;
      default:
        return 0;
    }
  }

  static security_and_host(): { host: string; secure: boolean } {
    const host = window.location;
    return { host: host.hostname, secure: host.protocol === "https:" };
  }

  static async generate_swarm_key(): Promise<ArrayBuffer> {
    const key = await crypto.subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      true, // extractable
      ["encrypt", "decrypt"],
    );

    const raw = await crypto.subtle.exportKey("raw", key);
    return raw;
  }

  // Heuristics

  static async _get_connection_cost(pc: RTCPeerConnection) {
    const stats = await pc.getStats();

    let rtt = 0;
    let aob = 0;
    let jitter = 0;

    let outbound_sent = 0;
    let outbound_lost = 0;

    let inbound_received = 0;
    let inbound_lost = 0;

    stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.state === "succeeded") {
        rtt = report.currentRoundTripTime ?? rtt;
        aob = report.availableOutgoingBitrate ?? aob;
      }

      if (report.type === "outbound-rtp") {
        outbound_sent += report.packetsSent ?? 0;
        outbound_lost += report.packetsLost ?? 0;
        jitter = report.jitter ?? jitter;
      }

      if (report.type === "inbound-rtp") {
        inbound_received += report.packetsReceived ?? 0;
        inbound_lost += report.packetsLost ?? 0;
        jitter = report.jitter ?? jitter;
      }
    });

    const outbound_plr =
      outbound_sent + outbound_lost > 0
        ? outbound_lost / (outbound_sent + outbound_lost)
        : 0;

    const inbound_plr =
      inbound_received + inbound_lost > 0
        ? inbound_lost / (inbound_received + inbound_lost)
        : 0;

    const plr = Math.max(outbound_plr, inbound_plr);
    const cost = rtt * 1000 + plr * 5000 + jitter * 1000 + 1 / (aob + 1);
    const quality = TorrentUtils.get_peer_quality({
      plr,
      rtt,
      jitter,
    });

    return {
      cost,
      rtt,
      plr,
      jitter,
      aob,
      quality,
    };
  }

  // use Exponential Moving Average (EMA) as distance
  static _ema_distance(prev_distance: number, cost: number, alpha = 0.1) {
    // honestly no clue what this is
    // but it is here and and that is what matters
    return alpha * cost + (1 - alpha) * prev_distance;
  }

  static get_peer_quality(metrics: {
    plr: number;
    rtt: number;
    jitter: number;
  }): TorrentPeerQuality {
    const { plr, rtt, jitter } = metrics;

    if (rtt < 0.08 && plr < 0.01 && jitter < 0.005) return "EXCELLENT";
    else if (rtt < 0.2 && plr < 0.03 && jitter < 0.015) return "GOOD";
    else if (rtt < 0.5 && plr < 0.08 && jitter < 0.03) return "FAIR";
    else if (rtt < 1.5 && plr < 0.2 && jitter < 0.1) return "POOR";
    else if (rtt >= 1.5 || plr >= 0.2 || jitter >= 0.1) return "BAD";
    else return "DEAD";
  }

  // something???
  static async verify_with_key(
    data: ArrayBuffer,
    signature: ArrayBuffer,
    public_key: CryptoKey | JsonWebKey,
  ): Promise<boolean> {
    const key =
      public_key instanceof CryptoKey
        ? public_key
        : await crypto.subtle.importKey(
            "jwk",
            public_key,
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["verify"],
          );

    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      data,
    );
  }

  static generate_salt(length = 32): ArrayBuffer {
    const salt = new Uint8Array(length);
    crypto.getRandomValues(salt);
    return salt.buffer.slice(0);
  }

  static async generate_mac(
    data: ArrayBuffer,
    raw_key: ArrayBuffer,
  ): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      raw_key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign("HMAC", key, data);
    return this.buffer_to_base64(signature);
  }

  static async verify_mac(
    data: ArrayBuffer,
    raw_key: ArrayBuffer,
    mac: string,
  ): Promise<boolean> {
    const key = await crypto.subtle.importKey(
      "raw",
      raw_key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signature = this.base64_to_buffer(mac);
    return crypto.subtle.verify("HMAC", key, signature, data);
  }

  static async encrypt(
    data: ArrayBuffer,
    raw_key: ArrayBuffer | CryptoKey,
  ): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key =
      raw_key instanceof ArrayBuffer
        ? await crypto.subtle.importKey(
            "raw",
            raw_key,
            { name: "AES-GCM" },
            false,
            ["encrypt"],
          )
        : raw_key;

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data,
    );

    // Prepend IV to encrypted data for later decryption
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return result.buffer;
  }

  static async decrypt(
    encrypted_data: ArrayBuffer,
    raw_key: ArrayBuffer | CryptoKey,
  ): Promise<ArrayBuffer | null> {
    try {
      const data = new Uint8Array(encrypted_data);
      const iv = data.slice(0, 12); // Extract IV
      const encrypted = data.slice(12); // Extract encrypted data

      const key =
        raw_key instanceof ArrayBuffer
          ? await crypto.subtle.importKey(
              "raw",
              raw_key,
              { name: "AES-GCM" },
              false,
              ["decrypt"],
            )
          : raw_key;

      return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    } catch {
      return null; // caller must guard
    }
  }

  static async create_aes_key(
    local_eph_private_key: CryptoKey,
    remote_eph_public_key: ArrayBuffer,
    salt: BufferSource,
  ): Promise<CryptoKey> {
    const external_pub_eph_key = await crypto.subtle.importKey(
      "raw",
      remote_eph_public_key,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );

    const shared_bits = await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: external_pub_eph_key,
      },
      local_eph_private_key,
      256,
    );

    const session_key = await crypto.subtle.importKey(
      "raw",
      shared_bits,
      { name: "HKDF" },
      false,
      ["deriveKey"],
    );

    const aes_key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: new TextEncoder().encode("torrent-session"),
      },
      session_key,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    return aes_key;
  }
}
