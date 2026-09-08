import { TorrentUtils } from "./torrent-utils";
import { KeyFormat } from "./torrent-types";

export class TorrentIdentity {
  readonly public_key: CryptoKey;
  private readonly private_key: CryptoKey;

  constructor(public_key: CryptoKey, private_key: CryptoKey) {
    this.public_key = public_key;
    this.private_key = private_key;
  }

  static async create(): Promise<TorrentIdentity> {
    const key_pair = await crypto.subtle.generateKey(
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      true,
      ["sign", "verify"],
    );

    return new TorrentIdentity(key_pair.publicKey, key_pair.privateKey);
  }

  async get_identifier(): Promise<string> {
    const publicBytes = await crypto.subtle.exportKey("raw", this.public_key);
    const hash = await crypto.subtle.digest("SHA-256", publicBytes);
    return TorrentUtils.buffer_to_base64(hash);
  }

  async export_public_key(
    format: KeyFormat = "jwk",
  ): Promise<ArrayBuffer | JsonWebKey> {
    return crypto.subtle.exportKey(format, this.public_key);
  }

  async sign(data: ArrayBuffer): Promise<ArrayBuffer> {
    return crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.private_key,
      data,
    );
  }
}
