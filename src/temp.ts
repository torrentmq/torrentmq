import { TorrentPeer } from "./index";

const peer = new TorrentPeer();

const seeder = peer.seeder("seeder");

// Create a furrow (queue) and subscribe
const furrow = seeder.furrow("furrow");
furrow.bind("routing_key");
const subscription = furrow.plant(
  { tag: "tag", exclusive: true },
  (message) => {
    console.log("received:", message.body);
    if (message.properties.headers?.source === "3") subscription.unplant();
  },
);
