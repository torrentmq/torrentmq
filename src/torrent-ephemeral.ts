export class TorrentEphemeral {
  readonly public_key: CryptoKey;
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

  async export_public(): Promise<ArrayBuffer> {
    return crypto.subtle.exportKey("raw", this.public_key);
  }

  async export_private(): Promise<ArrayBuffer> {
    return crypto.subtle.exportKey("raw", this.private_key);
  }

  async create_aes_key(
    eph_key: ArrayBuffer,
    salt: BufferSource,
  ): Promise<CryptoKey> {
    const external_pub_eph_key = await crypto.subtle.importKey(
      "raw",
      eph_key,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );

    const shared_bits = await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: external_pub_eph_key,
      },
      this.private_key,
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
