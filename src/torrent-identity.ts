import { TorrentUtils } from "./torrent-utils";

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

  // thhis is to import keys
  // avoids creating new ones and uses the same idenity
  static async from_jwk(public_jwk: JsonWebKey, private_jwk: JsonWebKey) {
    const public_key = await crypto.subtle.importKey(
      "jwk",
      public_jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );

    const private_key = await crypto.subtle.importKey(
      "jwk",
      private_jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );

    return new TorrentIdentity(public_key, private_key);
  }

  async get_identifier(): Promise<string> {
    const publicBytes = await crypto.subtle.exportKey("raw", this.public_key);
    const hash = await crypto.subtle.digest("SHA-256", publicBytes);
    return TorrentUtils.to_base64_url(hash);
  }

  async export_public_jwk(): Promise<JsonWebKey> {
    return crypto.subtle.exportKey("jwk", this.public_key);
  }

  async export_private_jwk(): Promise<JsonWebKey> {
    return crypto.subtle.exportKey("jwk", this.private_key);
  }

  async sign(data: ArrayBuffer): Promise<ArrayBuffer> {
    return crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.private_key,
      data,
    );
  }

  static async verify(
    data: ArrayBuffer,
    signature: ArrayBuffer,
    public_key: CryptoKey,
  ): Promise<boolean> {
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      public_key,
      signature,
      data,
    );
  }
}
