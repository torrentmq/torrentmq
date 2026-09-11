import type { KeyFormat } from "./torrent-types";

export class TorrentEphemeral {
  private readonly public_key: CryptoKey;
  private readonly private_key: CryptoKey;

  constructor(public_key: CryptoKey, private_key: CryptoKey) {
    this.public_key = public_key;
    this.private_key = private_key;
  }

  static async create(): Promise<TorrentEphemeral> {
    const key_pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );

    return new TorrentEphemeral(key_pair.publicKey, key_pair.privateKey);
  }

  async export_public_key(
    format: KeyFormat = "jwk",
  ): Promise<ArrayBuffer | JsonWebKey | CryptoKey> {
    if (format === "crypto") return this.public_key;
    return crypto.subtle.exportKey(format, this.public_key);
  }

  async export_private_key(
    format: KeyFormat = "jwk",
  ): Promise<ArrayBuffer | JsonWebKey | CryptoKey> {
    if (format === "crypto") return this.private_key;
    return crypto.subtle.exportKey(format, this.private_key);
  }
}
