import { TorrentMessageBody } from "./torrent-types";

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
