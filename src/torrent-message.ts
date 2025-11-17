import { TorrentSeeder } from "./torrent-seeder";
import { TorrentUtils } from "./torrent-utils";
import { TorrentMessageBody, TorrentMessageProperties } from "./torrent-types";

export class TorrentMessage {
  private utils: TorrentUtils = new TorrentUtils();
  readonly seeder: TorrentSeeder;
  properties: TorrentMessageProperties = {
    message_id: this.utils.random_string(),
  };
  body: TorrentMessageBody = null;

  constructor(seeder: TorrentSeeder, message_body: TorrentMessageBody) {
    this.seeder = seeder;
    this.body = message_body;
  }
}
