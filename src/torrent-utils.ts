import { TorrentError } from "./torrent-error";
import {
  Node,
  TorrentSeederFurrowSecurityObject,
  TorrentDeserializableBindingObjOf,
  TorrentDeserializableHostedObjOf,
  TorrentHostedBrand,
  TorrentHostedObj,
  TorrentMessageBody,
  TorrentMessageParams,
  TorrentPeerQuality,
  TorrentSerializableBindingKeyOf,
  TorrentSerializableHostedKeyOf,
  TorrentSerializableOrDeserializableBindingKey,
  TorrentSerializableOrDeserializableBindingObj,
} from "./torrent-types";

export class TorrentUtils {
  private static encoder = new TextEncoder();
  private static decoder = new TextDecoder();

  constructor() {}

  static random_string(minLength = 8, maxLength = 16) {
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

  static is_message_params(arg: unknown): arg is TorrentMessageParams {
    return (
      arg !== null &&
      typeof arg === "object" &&
      ("routing_key" in arg || "on_ack" in arg)
    );
  }

  static is_security_object(
    arg: unknown,
  ): arg is TorrentSeederFurrowSecurityObject {
    return (
      arg !== null &&
      typeof arg === "object" &&
      ("identity" in arg ||
        "identifier" in arg ||
        "pub_key" in arg ||
        "swarm_key" in arg)
    );
  }

  static security_and_host() {
    const is_secure = window.location.protocol === "https:";
    const host = window.location.hostname;

    return { host, is_secure };
  }

  static to_base64_url(buffer: ArrayBuffer): string {
    const binary = new Uint8Array(buffer).reduce(
      (data, byte) => data + String.fromCharCode(byte),
      "",
    );

    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  static from_base64_url(base64url: string): ArrayBuffer {
    // Restore padding and replace URL-safe charaters
    const base64 = base64url
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), "=");

    const binary_string = atob(base64);

    // Convert binary string to Uint8Array
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

    if (body instanceof Uint8Array) {
      return body.byteLength;
    }

    switch (typeof body) {
      case "string":
        return this.encoder.encode(body).byteLength;

      case "number":
      case "boolean":
        return this.encoder.encode(String(body)).byteLength;

      case "object":
        return this.encoder.encode(JSON.stringify(body)).byteLength;

      default:
        return 0;
    }
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

  serialize_hosted<T extends TorrentHostedObj>(
    value: T,
  ): TorrentSerializableHostedKeyOf<T> {
    return JSON.stringify(value) as TorrentSerializableHostedKeyOf<T>;
  }

  deserialize_hosted<K extends TorrentHostedBrand>(
    value: K,
  ): TorrentDeserializableHostedObjOf<K> {
    return JSON.parse(value) as TorrentDeserializableHostedObjOf<K>;
  }

  serialize_binding<T extends TorrentSerializableOrDeserializableBindingObj>(
    value: T,
  ): TorrentSerializableBindingKeyOf<T> {
    return JSON.stringify(value) as TorrentSerializableBindingKeyOf<T>;
  }

  deserialize_binding<K extends TorrentSerializableOrDeserializableBindingKey>(
    value: K,
  ): TorrentDeserializableBindingObjOf<K> {
    return JSON.parse(value) as TorrentDeserializableBindingObjOf<K>;
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
    return this.to_base64_url(signature);
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

    const signature = this.from_base64_url(mac);
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
  ): Promise<ArrayBuffer> {
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
  }

  static generate_salt(length = 32): ArrayBuffer {
    const salt = new Uint8Array(length);
    crypto.getRandomValues(salt);
    return salt.buffer;
  }

  static async _generate_swarm_key(): Promise<ArrayBuffer> {
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
}
