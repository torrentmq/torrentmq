export class TorrentWorker {
  instance: Worker;

  constructor() {
    this.instance = new Worker("");
  }
}
