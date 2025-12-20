import {
  TorrentBindingKey,
  TorrentBindingObj,
  TorrentFurrowParams,
  TorrentHostedKey,
  TorrentHostedObj,
  TorrentMessageParams,
  TorrentDeserializeObjOf,
  TorrentSerializeKeyOf,
  TorrentSeederParams,
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

  serialize<T extends TorrentBindingObj | TorrentHostedObj>(
    value: T,
  ): TorrentSerializeKeyOf<T> {
    return JSON.stringify(value) as TorrentSerializeKeyOf<T>;
  }

  deserialize<K extends TorrentBindingKey | TorrentHostedKey>(
    value: K,
  ): TorrentDeserializeObjOf<K> {
    return JSON.parse(value) as TorrentDeserializeObjOf<K>;
  }

  static to_base64_url(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  static from_base64_url(base64url: string): ArrayBuffer {
    // 1. Convert from base64url to standard base64
    let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");

    // 2. Add padding if missing (Base64 strings must have length % 4 === 0)
    const padLength = (4 - (base64.length % 4)) % 4;
    base64 += "=".repeat(padLength);

    // 3. Decode Base64 string to binary string
    const binaryString = atob(base64);

    // 4. Convert binary string to Uint8Array
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
  }

  static to_array_buffer(value: unknown): ArrayBuffer {
    if (value === null || value === undefined) {
      return new ArrayBuffer(0);
    }

    // Already a byte array
    if (value instanceof Uint8Array) {
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      return copy.buffer;
    }

    let str: string;

    switch (typeof value) {
      case "string":
        str = value;
        break;
      case "number":
      case "boolean":
        str = value.toString();
        break;
      case "object":
        str = JSON.stringify(value);
        break;
      default:
        throw new Error(`Cannot convert type ${typeof value} to ArrayBuffer`);
    }

    return this.encoder.encode(str).buffer;
  }

  static from_array_buffer(
    buffer: ArrayBuffer,
    typeHint?: "string" | "number" | "boolean" | "object",
  ): unknown {
    if (!buffer.byteLength) return null;

    const str = this.decoder.decode(buffer);

    if (!typeHint) return str; // default to string

    switch (typeHint) {
      case "string":
        return str;
      case "number":
        return Number(str);
      case "boolean":
        return str === "true";
      case "object":
        return JSON.parse(str);
      default:
        throw new Error(`Unsupported typeHint: ${typeHint}`);
    }
  }
}
