import { Node, TorrentMessageBody } from "./torrent-types";
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
}
