import { TorrentError } from "./torrent-error";
import { TorrentPeer } from "./torrent-peer";
import { TorrentSeeder } from "./torrent-seeder";
import { TorrentSeederParams } from "./torrent-types";

export class TorrentBroker {
  private seeders: TorrentSeeder[] = [];
  private rtc_client: TorrentPeer | undefined;
  rtc_connected: boolean = false;

  constructor() {
    return this;
  }

  async connect() {
    this.rtc_client = new TorrentPeer();
    this.rtc_client.on({
      PEER_CONNECTED: () => (this.rtc_connected = true),
      PEER_DISCONNECTED: () => (this.rtc_connected = false),
    });
  }

  seeder(
    arg1?: string | TorrentSeederParams,
    arg2?: string | TorrentSeederParams,
  ) {
    if (!this.rtc_connected)
      throw new TorrentError("You must connect to an RTC client");
    if (!this.rtc_client) throw new TorrentError("No RTC client");
    let name: string | undefined;
    let options: TorrentSeederParams | undefined;

    if (typeof arg1 === "string") {
      name = arg1;
      if (arg2 && typeof arg2 === "object") options = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      options = arg1;
      if (typeof arg2 === "string") name = arg2;
    }

    const seeder = new TorrentSeeder(name, options, this.rtc_client);
    this.seeders.push(seeder);
    return seeder;
  }
}
