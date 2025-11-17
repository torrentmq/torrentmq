import { TorrentBroker } from "./torrent-broker";

export class TorrentMQ {
  broker: TorrentBroker = new TorrentBroker();
  origin: string;

  constructor() {
    this.origin = window.location.origin;
    return this;
  }
}
