import { TorrentPeer } from "./index";

const peer = new TorrentPeer();

const seeder = peer.seeder("orders");

// Create a furrow (queue) and subscribe
const furrow = seeder.furrow("uk-orders");
furrow.bind("cool");
furrow.plant({ tag: "gooch", exclusive: true }, (message) => {
  console.log("received:", message.body);
});
