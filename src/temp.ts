import { TorrentPeer } from "./index";

const peer = new TorrentPeer();

const seeder = peer.seeder("orders");

// Create a furrow (queue) and subscribe
const furrow = seeder.furrow("uk-orders");
furrow.bind("cool");
const subscription = furrow.plant(
  { tag: "gooch", exclusive: true },
  (message) => {
    console.log("received:", message.body);
    if (message.properties.headers?.source === "3") subscription.unplant();
  },
);
subscription.unplant();
