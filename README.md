# Torrent — Decentralised Pub/Sub over WebRTC

Torrent is a browser-native peer-to-peer messaging library. It builds a self-healing mesh network of WebRTC data channels, then layers a publish/subscribe broker on top — giving you encrypted, authenticated message delivery without a central server handling your traffic.

---

## Table of Contents

1. [Architecture overview](#architecture-overview)
2. [Core concepts](#core-concepts)
3. [Quick start](#quick-start)
4. [API reference](#api-reference)
   - [TorrentPeer](#torrentpeer)
   - [TorrentSeeder](#torrentseeder)
   - [TorrentFurrow](#torrentfurrow)
   - [TorrentMessage](#torrentmessage)
   - [TorrentSignaller](#torrentsignaller)
   - [TorrentSignallingServer](#torrentsignallingserver)
5. [Security model](#security-model)
6. [Leader election](#leader-election)
7. [Message routing](#message-routing)
8. [Network layer](#network-layer)
9. [Utility classes](#utility-classes)
10. [Type reference](#type-reference)
11. [Configuration](#configuration)
12. [Running a signalling server](#running-a-signalling-server)

---

## Architecture overview

```
Browser A                                   Browser B                    Browser C
┌────────────────────────────┐              ┌─────────────┐              ┌─────────────┐
│ TorrentPeer                │◄────DC──────►│ TorrentPeer │◄────DC──────►│ TorrentPeer │
│                            │              │             │              │             │
│  TorrentSeeder "orders"    │              │             │              │             │
│    TorrentFurrow "uk"      │              │             │              │             │
└────────────────────────────┘              └─────────────┘              └─────────────┘
              │                                    │                            │
              └────────────────────────────────────┴────────────────────────────┘
                               WebSocket
                         TorrentSignallingServer
                        (used for ICE/SDP only)
```

Peers discover each other through a lightweight WebSocket signalling server. Once a WebRTC data channel is open, all control and message traffic moves peer-to-peer; the signalling server is only consulted again for ICE candidates and partition recovery.

---

## Core concepts

**TorrentPeer** — the network node. Each browser tab is one peer. Peers form a cluster of 4–8 connections, self-heal when peers leave, and forward messages using a weighted k-best forwarding algorithm.

**TorrentSeeder** — analogous to an exchange in AMQP. A seeder has a name, an ECDSA identity, and an AES-GCM swarm key used to encrypt all messages it carries. Multiple peers can host a seeder with the same name; one is elected _master_ and the others become _shadows_.

**TorrentFurrow** — analogous to a queue. A furrow belongs to a seeder, has its own identity and swarm key, and can be _planted_ (subscribed) or _bound_ (registered for routing). Like seeders, furrows participate in leader election independently.

**Master / Shadow** — only the master seeder or furrow signs and publishes messages. If the master disappears, a shadow promotes itself after a randomised failover window (default 3–4 seconds) to avoid split-brain.

**Swarm key** — a 256-bit AES-GCM key shared among all peers that hold the same seeder or furrow. It is exchanged over an ephemeral ECDH tunnel and rotated every 10 minutes by the master.

---

## Quick start

### Install

```bash
npm install torrentmq
```

### Start a signalling server (Node.js)

```typescript
import { TorrentSignallingServer } from "torrentmq";

new TorrentSignallingServer();
// Listens on ws://localhost:6767/ws by default
```

### Connect a peer and send a message

```typescript
import { TorrentPeer } from "torrentmq";

const peer = new TorrentPeer();

peer.on("signaller_connected", async () => {
  // Create a seeder (exchange)
  const seeder = await peer.seeder("orders");

  // Send a message on the seeder
  seeder.send({ type: "order_placed", id: 42 });
});
```

### Receive messages

```typescript
import { TorrentPeer } from "torrentmq";

const peer = new TorrentPeer();

peer.on("signaller_connected", async () => {
  const seeder = await peer.seeder("orders");

  // Create a furrow (queue) and subscribe
  const furrow = await seeder.furrow("uk-orders");
  furrow.bind();
  furrow.plant((message) => {
    console.log("received:", message.body);
  });
});
```

### Furrow with a routing key

```typescript
const furrow = await seeder.furrow("uk-orders");
furrow.bind("peer-abc-routing-key");
furrow.plant({ tag: "consumer-1" }, (message) => {
  console.log(message.body);
});
```

---

## API reference

### TorrentPeer

The top-level class. Extend or instantiate directly.

```typescript
const peer = new TorrentPeer(options?);
```

**Options**

| Option                  | Type     | Default       | Description                                             |
| ----------------------- | -------- | ------------- | ------------------------------------------------------- |
| `ws_url`                | `string` | auto-detected | WebSocket signalling server URL (`ws://` or `wss://`)   |
| `min_peer_cluster_size` | `number` | `4`           | Minimum peers before triggering partition heal          |
| `max_peer_cluster_size` | `number` | `8`           | Maximum simultaneous peer connections                   |
| `status_frequency`      | `number` | `60000`       | How often (ms) to sample and broadcast connection stats |
| `partion_heal_interval` | `number` | `60000`       | How often (ms) to attempt partition recovery            |
| `lru_size`              | `number` | `1024`        | Capacity of the message deduplication LRU cache         |

**Methods**

```typescript
// Create a seeder hosted by this peer
peer.seeder(name?: string, options?: TorrentSeederParams): Promise<TorrentSeeder>
peer.seeder(options?: TorrentSeederParams, name?: string): Promise<TorrentSeeder>

// Low-level publish (called internally by TorrentSeeder/TorrentFurrow)
peer.publish(msg): void
peer.submit(msg): void

// DHT lookup — find which peer hosts seeder/furrow by name
peer.find(seeder, furrow?): void

// Bind / unbind a furrow routing entry in the broker
peer.register_remote_binding(seeder, furrow): void
peer.unregister_remote_binding(seeder, furrow): void

// Trigger a swarm key refresh broadcast
peer.swarm_key_refresh(seeder, furrow?): void

// Send a heartbeat lease pulse
peer.send_pulse(lease_term, seeder, furrow?): void

// DHT node methods (inherited)
peer.store(data): void
peer.retrieve(key): TorrentControlMessage | null
peer.sync(to_peer_id): void
peer.get_network_graph(): Map<string, string[]>
peer.close_peer_connection(peer_id): void
```

**Events**

```typescript
peer.on("signaller_connected", () => { ... });
peer.on("peer_connected",      ({ peer_id, dc }) => { ... });
peer.on("peer_disconnected",   ({ peer_id }) => { ... });
peer.on("message_receive",     (msg: TorrentControlMessage) => { ... });
peer.on("publish",             (msg) => { ... });
peer.on("found",               ({ seeder, furrow, peer_id }) => { ... });
peer.on("not_found",           ({ seeder }) => { ... });
peer.on("message_malformed",   (msg) => { ... });
peer.on("bind",                ({ seeder, furrow }) => { ... });
peer.on("unbind",              ({ seeder, furrow }) => { ... });
peer.on("ack",                 ({ message_id, peer_id }) => { ... });
peer.on("status_update",       (msg) => { ... });
```

---

### TorrentSeeder

Created via `peer.seeder(...)`. Do not call the constructor directly.

**Properties**

| Property     | Type                  | Description                                 |
| ------------ | --------------------- | ------------------------------------------- |
| `name`       | `string`              | Human-readable name                         |
| `identifier` | `string`              | SHA-256 fingerprint of the ECDSA public key |
| `pub_key`    | `JsonWebKey`          | ECDSA public key (JWK format)               |
| `swarm_key`  | `ArrayBuffer`         | AES-GCM shared key                          |
| `furrows`    | `TorrentFurrow[]`     | Owned furrows                               |
| `options`    | `TorrentSeederParams` | Creation options                            |

**Methods**

```typescript
// Send a message on this seeder
seeder.send(body?: TorrentMessageBody, params?: TorrentMessageParams): void
seeder.send(params?: TorrentMessageParams, body?: TorrentMessageBody): void

// Create a furrow belonging to this seeder
seeder.furrow(name?: string, options?: TorrentFurrowParams): Promise<TorrentFurrow>

seeder.get_swarm_key(): ArrayBuffer
seeder.get_mode(): "master" | "shadow"
```

**Events**

```typescript
seeder.on("seeder_promoted", ({ seeder }) => { ... }); // this seeder became master
seeder.on("seeder_demoted",  ({ id, name }) => { ... }); // stepped down to shadow
seeder.on("furrow_promoted", ({ seeder, furrow }) => { ... });
seeder.on("furrow_demoted",  ({ seeder, furrow }) => { ... });
seeder.on("created_furrow",  ({ seeder, furrow }) => { ... });
```

**TorrentSeederParams**

```typescript
type TorrentSeederParams = {
  type?: "direct" | "topic" | "fanout"; // routing hint (informational)
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
  internal?: boolean;
  key_refresh?: number; // swarm key rotation interval in ms (default: 600000)
  args?: Record<string, any>;
};
```

---

### TorrentFurrow

Created via `seeder.furrow(...)`. Do not call the constructor directly.

**Properties**

| Property     | Type                 | Description                                  |
| ------------ | -------------------- | -------------------------------------------- |
| `name`       | `string`             | Human-readable name                          |
| `identifier` | `string`             | SHA-256 fingerprint of the ECDSA public key  |
| `pub_key`    | `JsonWebKey`         | ECDSA public key (JWK format)                |
| `is_planted` | `boolean \| "unset"` | Whether a consumer callback is active        |
| `is_bound`   | `boolean`            | Whether the furrow is registered for routing |

**Methods**

```typescript
// Send a message scoped to this furrow
furrow.send(body?: TorrentMessageBody, params?: TorrentMessageParams): void

// Subscribe — callback is called for every verified, decrypted message
furrow.plant(callback?: TorrentCallBack, params?: TorrentConsumeParams): void
furrow.plant(params?: TorrentConsumeParams, callback?: TorrentCallBack): void

// Unsubscribe
furrow.unplant(): void

// Register / deregister with the distributed broker
furrow.bind(routing_key?: string): void
furrow.unbind(routing_key?: string): void

furrow.get_swarm_key(): ArrayBuffer
furrow.get_mode(): "master" | "shadow"
```

**Events**

```typescript
furrow.on("furrow_promoted", ({ furrow }) => { ... });
furrow.on("furrow_demoted",  ({ id, name }) => { ... });
```

**TorrentFurrowParams**

```typescript
type TorrentFurrowParams = {
  exclusive?: boolean;
  auto_bind?: boolean;
  auto_plant?: boolean;
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
  key_refresh?: number; // ms, default: 600000
};
```

---

### TorrentMessage

Represents a single message, both before and after encryption. You receive instances of this class in plant callbacks.

```typescript
class TorrentMessage {
  body: TorrentMessageBody; // null | string | number | boolean | object | Uint8Array
  properties: TorrentMessageProperties;
  on_ack?: TorrentAckCallBack;
}

type TorrentMessageProperties = {
  message_id?: string;
  routing_key?: string;
  re_delivered?: boolean;
  body_size?: number;
  headers?: {
    hop_count?: number;
    retry_count?: number;
    content_type?: string;
  };
};
```

**TorrentMessageParams** (pass when sending)

```typescript
type TorrentMessageParams = {
  routing_key?: string;
  on_ack?: (data: any) => void;
};
```

---

### TorrentSignaller

Manages the WebSocket connection to the signalling server. Used internally by `TorrentDHTNode`; you do not normally need to use this class directly.

```typescript
const sig = new TorrentSignaller();
sig.connect(server_url?: string);  // auto-detects ws:// vs wss://
sig.send(msg: TorrentSignalMessage): void;
sig.close(): void;
sig.get_identifier(): string;

sig.on("open",    (msg: TorrentSignalEventMessage) => { ... });
sig.on("close",   (msg: TorrentSignalEventMessage) => { ... });
sig.on("message", (msg: TorrentSignalMessage) => { ... });
sig.on("error",   (err: TorrentError) => { ... });
```

The signaller validates that `wss://` is used when the page is served over HTTPS.

---

### TorrentSignallingServer

A minimal WebSocket relay for Node.js. It broadcasts every incoming message to all other connected clients. It has no persistence or authentication — all security happens at the peer layer.

```typescript
import { TorrentSignallingServer } from "torrentmq";

const server = new TorrentSignallingServer();
// or with options:
server.create_server({ port: 6767, debug: true });
```

The default port is **6767**. Only `/ws` is served as a WebSocket endpoint.

---

## Security model

Every message in the system is authenticated and encrypted at two layers.

### Identity layer (ECDSA P-256)

Each peer, seeder, and furrow generates an ECDSA P-256 key pair on creation. The SHA-256 hash of the raw public key becomes the `identifier`. Signed fields cover the entire control message body excluding the signature itself, making replay or tampering detectable.

- **PUBLISH** messages are signed by the seeder or furrow identity.
- **SUBMIT** messages (sent by shadows) are forwarded to the master peer, which re-signs them before broadcasting.
- All other control messages (`FIND`, `FOUND`, `PULSE`, etc.) are signed by the sending peer's own identity.

### Encryption layer (AES-GCM 256)

Message bodies are encrypted with the seeder or furrow's swarm key before being put on the wire. An HMAC-SHA-256 MAC is computed over the ciphertext to provide additional integrity verification.

### Swarm key exchange (ECDH P-256 + HKDF)

When a peer discovers a remote seeder or furrow (via `FOUND`), it initiates an ephemeral key exchange:

1. The discovering peer generates an ephemeral ECDH P-256 key pair and sends `EPH_KEY_OFFER` to the hosting peer.
2. The hosting peer generates its own ephemeral pair, signs the remote's public key with its identity key, encrypts the swarm key with an ECDH-derived AES-GCM key (using HKDF-SHA-256 with label `torrent-session`), and replies with `EPH_KEY_EXCHANGE`.
3. The discovering peer verifies the signature, derives the same AES key, and decrypts the swarm key.

The ephemeral keys are discarded immediately after the exchange. Swarm keys are rotated by the master on a configurable interval (default every 10 minutes).

---

## Leader election

Seeders and furrows use a lease-based master/shadow model with randomised failover.

- The **master** broadcasts a `PULSE` every second containing a `lease_term` (current time + 3 seconds).
- **Shadow** instances reset a watchdog timer every time they receive a valid pulse from the current master. The watchdog window is `3000 + random(0, 1000)` ms, so shadows don't all promote simultaneously.
- If the watchdog fires (master silent), the shadow promotes itself to master, re-publishes a pulse, and restarts the key refresh interval.
- If two masters conflict (tie detected via `identifier.localeCompare`), the lexicographically smaller identifier wins and the loser demotes itself.

---

## Message routing

### Publish vs Submit

**Publish** — the sending peer is the master and signs the message itself. The signed payload is broadcast to all connected peers over data channels using weighted k-best forwarding.

**Submit** — the sending peer is a shadow. It sends the message to the network; the peer hosting the master seeder or furrow intercepts it, re-signs it, and re-broadcasts as a `PUBLISH`.

### Weighted k-best forwarding (W-KBF)

For `PUBLISH` messages, rather than flooding the entire cluster, the peer selects `k = ceil(sqrt(connected_peers))` candidates ranked by an exponential moving average (EMA) of connection cost:

```
cost = rtt_ms + plr × 5000 + jitter_ms + 1 / (available_bitrate + 1)
```

Peers without measured stats are included as random wildcards so new connections still receive traffic.

All other control messages (`FIND`, `FOUND`, `PULSE`, etc.) are naively forwarded to all connected peers.

### Broker bindings and routing keys

When `furrow.bind(routing_key?)` is called, the furrow registers itself in the peer's local broker bindings map and broadcasts a `BROKER_MANIFEST` to all connected peers. Remote peers store this manifest so they can make local routing decisions without a round-trip.

On delivery, a `PUBLISH` message is accepted if its `routing_key` matches the bound routing key of a local furrow, or if either is empty.

### Deduplication

Every control message carries a `control_id`. Each peer keeps a fixed-size LRU cache (default 1024 entries) of seen `control_id` values. Duplicate messages are silently dropped. On new peer connection, the full LRU cache is synced to the new peer to prevent re-delivery of already-seen messages.

---

## Network layer

`TorrentDHTNode` (parent of `TorrentPeer`) manages the WebRTC mesh:

- **HELO** — broadcast on connection; triggers connection attempts from peers that aren't at capacity.
- **HIHI** — unicast response to HELO; used when the receiver hasn't heard of the sender yet.
- **YOYO** — sent on a timer when the peer cluster is below `min_peer_cluster_size`; triggers partition recovery.
- **OFFER / ANSWER / ICE** — standard WebRTC signalling, routed via the WebSocket server or relayed over existing data channels.
- **STATUS** — periodic broadcast of RTT, PLR, and connected-peer list used to build a topology graph on each node.

Peers use a deterministic lexicographic tie-break (`identifier.localeCompare`) to decide who initiates a connection when both sides discover each other simultaneously, preventing duplicate connections.

The worst-quality peer (highest EMA distance) is evicted when the cluster would exceed `max_peer_cluster_size`.

---

## Utility classes

### TorrentUtils

Static helpers used throughout the library.

```typescript
TorrentUtils.random_string(minLength?, maxLength?): string
TorrentUtils.to_base64_url(buffer: ArrayBuffer): string
TorrentUtils.from_base64_url(base64url: string): ArrayBuffer
TorrentUtils.to_array_buffer(value: unknown): ArrayBuffer   // full type-preserving serialisation
TorrentUtils.from_array_buffer<T>(buffer: ArrayBuffer): T   // deserialise
TorrentUtils.compute_body_size(body: TorrentMessageBody): number
TorrentUtils.encrypt(data, key): Promise<ArrayBuffer>       // AES-GCM, IV prepended
TorrentUtils.decrypt(data, key): Promise<ArrayBuffer | null>
TorrentUtils.generate_mac(data, key): Promise<string>       // HMAC-SHA-256
TorrentUtils.verify_mac(data, key, mac): Promise<boolean>
TorrentUtils.get_peer_quality(metrics): TorrentPeerQuality  // EXCELLENT | GOOD | FAIR | POOR | BAD | DEAD
TorrentUtils.generate_salt(length?): ArrayBuffer
TorrentUtils._generate_swarm_key(): Promise<ArrayBuffer>    // AES-GCM 256 key
TorrentUtils.security_and_host(): { host, is_secure }
TorrentUtils.is_signal_message(obj): boolean
TorrentUtils.is_message_params(arg): boolean
TorrentUtils.is_security_object(arg): boolean
```

`to_array_buffer` / `from_array_buffer` handle the full JavaScript type graph: primitives, `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, typed arrays, circular references, `NaN`, `Infinity`, and `BigInt`.

### TorrentIdentity

Wraps ECDSA P-256 key pairs.

```typescript
const id = await TorrentIdentity.create();
const id = await TorrentIdentity.from_jwk(public_jwk, private_jwk);

await id.get_identifier(): Promise<string>        // base64url SHA-256 of raw public key
await id.sign(data: ArrayBuffer): Promise<ArrayBuffer>
await TorrentIdentity.verify(data, signature, public_key): Promise<boolean>
await id.export_public_jwk(): Promise<JsonWebKey>
await id.export_private_jwk(): Promise<JsonWebKey>
await TorrentIdentity.jwk_to_crypto(jwk): Promise<CryptoKey>
```

### TorrentEphemeral

Wraps ECDH P-256 key pairs for one-off key exchanges.

```typescript
const eph = await TorrentEphemeral.create();
await eph.export_public(): Promise<ArrayBuffer>
await eph.create_aes_key(remote_pub_key, salt): Promise<CryptoKey>
// Returns a non-extractable AES-GCM-256 key derived via ECDH + HKDF-SHA-256
```

### TorrentLRUCache

A doubly-linked list LRU cache used for both signal and control message deduplication.

```typescript
const cache = new TorrentLRUCache<K, V>(capacity?: number); // default 512
cache.get(key): V | undefined
cache.set(key, value): void
cache.has(key): boolean
cache.get_map(): Map<K, TorrentLRUNode<K, V>>
```

### TorrentEmitter

A typed event emitter used as a base class throughout the library.

```typescript
emitter.on(event: string, listener: (data) => void): void
emitter.on(handlers: Partial<Record<EventName, (data) => void>>): void
// emit is protected — only subclasses can fire events
```

### TorrentError

```typescript
throw new TorrentError("something went wrong");
// .name === "TorrentError"
```

---

## Type reference

Key types exported from `torrent-types.ts`:

| Type                       | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `TorrentSeederFurrowMode`  | `"master" \| "shadow"`                                                 |
| `TorrentMessageBody`       | `Uint8Array \| string \| number \| boolean \| object \| null`          |
| `TorrentMessageProperties` | Message metadata (routing key, headers, ID, etc.)                      |
| `TorrentCallBack`          | `(message: TorrentMessage) => void`                                    |
| `TorrentAckCallBack`       | `(data: any) => void`                                                  |
| `TorrentHostedObj`         | Seeder/furrow descriptor (id, name, pub_key or cert, mode, properties) |
| `TorrentPeerQuality`       | `"EXCELLENT" \| "GOOD" \| "FAIR" \| "POOR" \| "BAD" \| "DEAD"`         |
| `TorrentPeerEntry`         | `{ pc, dc?, bb?, ice_queue?, making_offer?, stats? }`                  |
| `TorrentSignalMessage`     | Union of all WebRTC signalling messages                                |
| `TorrentControlMessage`    | Union of all data-channel control messages                             |
| `TorrentCertificate`       | Optional PKI cert for delegated authority                              |

---

## Configuration

### Constants (`torrent-consts.ts`)

| Constant                 | Value  | Description                       |
| ------------------------ | ------ | --------------------------------- |
| `TORRENT_PORT`           | `6767` | Default WebSocket signalling port |
| `TORRENT_LEASE_DURATION` | `3000` | Master heartbeat lease in ms      |

### Peer cluster sizing

The cluster floor (`min_peer_cluster_size`, default 4) and ceiling (`max_peer_cluster_size`, default 8) control how aggressively the node seeks new connections and when it evicts poor-quality peers.

### Key refresh

The swarm key rotation period can be set per-seeder and per-furrow via the `key_refresh` option (in ms). The default is 10 minutes. Set to a lower value for higher security at the cost of more key-exchange traffic.

---

## Running a signalling server

The included `TorrentSignallingServer` is a minimal Node.js relay. For production you should add TLS termination in front of it (nginx, Caddy, etc.) so browsers can connect via `wss://`.

```typescript
import { TorrentSignallingServer } from "torrentmq";

const srv = new TorrentSignallingServer();
srv.create_server({ port: 8443, debug: false });
```

The server only relays `HELO`, `HIHI`, `YOYO`, `OFFER`, `ANSWER`, `ICE`, and `STATUS` messages. Once peers have data channels open, they relay signalling messages to each other directly, reducing load on the server.

The server has no authentication, no persistence, and no message storage. It is intentionally dumb — all trust is established peer-to-peer.
