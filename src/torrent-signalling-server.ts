import { TORRENT_PORT } from "./torrent-consts";
import { TorrentError } from "./torrent-error";
import http from "http";
import { WebSocketServer } from "ws";

export class TorrentSignallingServer {
  private server?: any;
  private wss?: WebSocketServer;

  constructor() {
    if (typeof window === "undefined")
      throw new TorrentError(
        "TorrentSignallingServer can only be used in a Node.js environment",
      );

    this.create_server();
  }

  create_server(options?: { port?: number; debug?: boolean }) {
    const port = options?.port || TORRENT_PORT;

    this.server = http.createServer((req, res) => {
      res.writeHead(200);
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      if (req.url === "/ws") {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        if (options?.debug) console.log("Received:", data.toString());

        this.wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === ws.OPEN) {
            client.send(data.toString());
          }
        });
      });
    });

    this.server.listen(port, () => {});
  }
}
