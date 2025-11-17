export class TorrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TorrentError";
  }
}
