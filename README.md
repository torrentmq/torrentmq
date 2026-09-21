# TorrentMQ - Decentralised Pub/Sub over WebRTC

TorrentMQ is a browser-native peer-to-peer messaging library. It builds on a self-healing partial mesh network of WebRTC `RTCDataChannel` connections, then layers a publish/subscribe message broker on top. This provides encrypted, authenticated message delivery without a central server routing traffic.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Concepts](#core-concepts)
3. [Quick Start](#quick-start)
   - [Installation](#installation)
   - [Peer Initialization & Basic Messaging](#peer-initialization--basic-messaging)
   - [Subscribing via Furrow Plants](#subscribing-via-furrow-plants)
   - [Routing Keys & Pattern Matching](#routing-keys--pattern-matching)
4. [API Reference](#api-reference)
   - [TorrentPeer](#torrentpeer)
   - [TorrentSeeder](#torrentseeder)
   - [TorrentFurrow](#torrentfurrow)
   - [TorrentMessage](#torrentmessage)
   - [TorrentSignaller](#torrentsignaller)
   - [TorrentIdentity](#torrentidentity)
   - [TorrentLRUCache](#torrentlrucache)
5. [Security Model](#security-model)
   - [Identity Layer (ECDSA P-256)](#identity-layer-ecdsa-p-256)
   - [Encryption Layer (AES-GCM 256)](#encryption-layer-aes-gcm-256)
6. [Leader Election & Dual-Root Reconciliation](#leader-election--dual-root-reconciliation)
7. [Message Routing & Network Heuristics](#message-routing--network-heuristics)
   - [Weighted K-Best Forwarding (W-KBF)](#weighted-k-best-forwarding-w-kbf)
   - [Exchange Routing Modes](#exchange-routing-modes)
8. [Internal Contexts](#internal-contexts)
   - [TorrentPeerContext](#torrentpeercontext)
   - [TorrentSeederContext](#torrentseedercontext)
   - [TorrentFurrowContext](#torrentfurrowcontext)
9. [Utility & Helper Classes](#utility--helper-classes)
10. [Type Reference](#type-reference)
11. [Configuration & Constants](#configuration--constants)

---

## Architecture Overview

```
Browser Tab A                                Browser Tab B                   Browser Tab C
┌────────────────────────────┐              ┌─────────────┐                 ┌─────────────┐
│ TorrentPeer                │◄────DC──────►│ TorrentPeer │◄─────DC────────►│ TorrentPeer │
│  ├─ TorrentPeerContext     │              │             │                 │             │
│  ├─ TorrentSeeder "events" │              │             │                 │             │
│  └─ TorrentFurrow "logger" │              │             │                 │             │
└────────────────────────────┘              └─────────────┘                 └─────────────┘
              │                                    │                               │
              └────────────────────────────────────┴───────────────────────────────┘
                                   WebSocket (SDP/ICE)
                               TorrentSignallingServer
```

1. **Signalling Phase**: Peers discover each other using a lightweight WebSocket signalling server (`TorrentSignaller`). The server coordinates `HELO`, `HIHI`, `YOYO` (partition healing), SDP `OFFER`/`ANSWER`, and `ICE` candidate exchanges.
2. **Data Phase**: Once an `RTCDataChannel` is established, control and data messages bypass the signalling server completely.
3. **Mesh Management**: Each peer maintains between 4 (`min_cluster_size`) and 8 (`max_cluster_size`) connected neighbors. Weak or distant connections are dynamically evicted using network heuristic costs.

---

## Core Concepts

- **TorrentPeer**: Represents a browser tab or node within the peer mesh. Manages connection pools, statistical measurements, and control message routing.
- **TorrentSeeder**: Analagous to an AMQP exchange. Has a name, cryptographic identity, and swarm key. Multiple peers can join the same seeder, automatically electing a `ROOT` node while others act as `SHADOW` fallbacks.
- **TorrentFurrow**: Analagous to an AMQP queue bound to a seeder. Maintains consumer plant callbacks and pattern matching logic. Participates in its own leader election independently of its parent seeder.
- **Root vs. Shadow**: Only the `ROOT` node publishes signed, authenticated messages for a given seeder or furrow. If the `ROOT` disconnects, `SHADOW` nodes perform jittered election takeovers.
- **Swarm Key**: A 256-bit AES-GCM key used to encrypt all payloads for a specific seeder or furrow context. Shared dynamically via ephemeral ECDH handshakes (`EPH_KEY_OFFER`/`EPH_KEY_EXCHANGE`).

---

## Quick Start

### Installation

```bash
npm install torrentmq
```

### Peer Initialization & Basic Messaging

```typescript
import { TorrentPeer } from "torrentmq";

// Initialize a local node
const peer = new TorrentPeer({
  server_url: "wss://signaller.example.com/ws",
  min_cluster_size: 4,
  max_cluster_size: 8,
});

// Access or create an exchange seeder
const seeder = peer.seeder("analytics", { type: "fanout" });

// Send a broadcast message
await seeder.send({ event: "USER_CLICK", x: 120, y: 340 });
```

### Subscribing via Furrow Plants

```typescript
import { TorrentPeer } from "torrentmq";

const peer = new TorrentPeer();
const seeder = peer.seeder("analytics");
const furrow = seeder.furrow("click-logger");

// Plant a subscription consumer
const subscription = furrow.plant(
  { tag: "analytics-worker", no_ack: true },
  (message) => {
    console.log("Received payload:", message.body);
    console.log("Sender identity:", message.properties.headers?.source);
    
    // Stop receiving messages when done
    subscription.unplant();
  }
);
```

### Routing Keys & Pattern Matching

```typescript
const topicSeeder = peer.seeder("notifications", { type: "topic" });
const furrow = topicSeeder.furrow("email-worker");

// Bind topic patterns
furrow.bind("user.*.created");

furrow.plant((message) => {
  console.log("Matched event on key:", message.properties.routing_key);
  console.log("Body:", message.body);
});

// Publish matching routing keys
await topicSeeder.send(
  { userId: "usr_99", status: "pending" },
  { routing_key: "user.eu.created" }
);
```

---

## API Reference

### TorrentPeer

`TorrentPeer` represents the local mesh node.

#### `constructor(options?: TorrentPeerOptions & { server_url?: TorrentWebSocketUrl; store_size?: number })`
Creates a peer node and connects to the signalling server.

#### `get identifier(): string`
Returns the cryptographic identity hash of the underlying peer context.

#### `seeder(name?: string, options?: TorrentSeederParams): TorrentSeeder`
Returns an existing `TorrentSeeder` instance by name, or creates a new one if it does not exist.

---

### TorrentSeeder

`TorrentSeeder` acts as the exchange for routing messages.

#### `get identifier(): string`
Returns the public hash identifier of the seeder.

#### `get name(): string`
Returns the string name assigned to the seeder.

#### `get options(): TorrentSeederParams`
Returns configuration options assigned to the seeder.

#### `send(body?: TorrentMessageBody, params?: TorrentMessageParams): Promise<void>`
Publishes a payload through the seeder across the peer mesh.

#### `furrow(name?: string, options?: TorrentFurrowParams): TorrentFurrow`
Returns an existing child `TorrentFurrow` or creates a new one bound to this seeder.

---

### TorrentFurrow

`TorrentFurrow` acts as a message queue attached to a seeder.

#### `get identifier(): string`
Returns the public hash identifier of the furrow.

#### `get name(): string`
Returns the string name assigned to the furrow.

#### `get options(): TorrentFurrowParams`
Returns configuration options assigned to the furrow.

#### `send(body?: TorrentMessageBody, params?: TorrentMessageParams): Promise<void>`
Publishes a message directly targetting this furrow.

#### `bind(routing_key: string): void`
Registers a routing pattern for message filtering.

#### `unbind(routing_key: string): void`
Removes a registered routing key.

#### `plant(callback: TorrentCallback, params?: TorrentConsumeParams): TorrentSubscription`
Registers a callback to consume incoming messages matching this furrow.

---

### TorrentMessage

Constructs and serializes payloads routed through the mesh.

#### Properties
- `body`: `TorrentMessageBody` (Primitive, ArrayBuffer, TypedArray, Object, Map, Set, Date, RegExp, BigInt).
- `properties`: `TorrentMessageProperties` (Headers, routing key, content type, TTL, message ID, body size).
- `on_ack`: Optional callback executed when an explicit `ACK` control frame is returned.

---

### TorrentSignaller

Extends `TorrentEmitter`. Handles WebSocket connection management to the signaling server.

#### `connect(server_url?: TorrentWebSocketUrl): void`
Establishes a WebSocket connection to the designated signaller endpoint.

#### `disconnect(): void`
Closes active WebSocket connections.

#### `send(msg: TorrentSignalMessage): void`
Transmits raw signalling frames (`HELO`, `HIHI`, `YOYO`, `OFFER`, `ANSWER`, `ICE`).

---

### TorrentIdentity

Encapsulates Web Crypto API ECDSA `P-256` keypair operations.

#### `static create(): Promise<TorrentIdentity>`
Generates a new ECDSA `P-256` key pair.

#### `get_identifier(): Promise<string>`
Exports the public key, hashes it via SHA-256, and returns a URL-safe Base64 identifier.

#### `sign(data: ArrayBuffer): Promise<ArrayBuffer>`
Signs binary data with the private key using SHA-256 hashing.

#### `export_public_key(format?: KeyFormat): Promise<ArrayBuffer | JsonWebKey | CryptoKey>`
Exports the public key in standard representations (`jwk`, `spki`, `raw`, `crypto`).

---

### TorrentLRUCache

Extends `TorrentEmitter<"set">`. Implements a Least-Recently-Used double-linked-list cache used internally for message de-duplication.

#### `get(key: K): V | undefined`
Retrieves an item and moves it to the head of the cache.

#### `set(key: K, value: V): void`
Inserts or updates an item. Evicts the oldest tail item if cache capacity exceeds `capacity` (default: 512).

---

## Security Model

```
       ┌──────────────────────────────────────────────────────────┐
       │                 Control Message Payload                  │
       ├────────────────────────────┬─────────────────────────────┤
       │ ECDSA P-256 Signature      │ AES-GCM Encrypted Body      │
       │ Identifies originating     │ Shared 256-bit Swarm Key    │
       │ peer or seeder node        │ Double-buffered on refresh  │
       └────────────────────────────┴─────────────────────────────┘
```

### Identity Layer (ECDSA P-256)
- Every node generates a non-extractable Web Crypto API ECDSA `P-256` keypair (`TorrentIdentity`).
- Outgoing control frames carry an `artifacts` envelope containing `public_key` (JWK), `timestamp`, and `signature`.
- Neighbors verify message authenticity via `TorrentUtils.verify_with_key` before relaying or processing packets.

### Encryption Layer (AES-GCM 256)
- Content bodies are encrypted using 256-bit AES-GCM with a 12-byte initialization vector (IV) prepended to the ciphertext.
- Message envelopes include HMAC-SHA256 signatures (`mac`) derived from the swarm key to guarantee integrity.
- Swarm keys are distributed via Diffie-Hellman Key Exchange (`TorrentEphemeral` using `ECDH P-256`) and HKDF key derivation.

---

## Leader Election & Dual-Root Reconciliation

Each `TorrentSeederContext` and `TorrentFurrowContext` implements a distributed term-incrementing lease election:

1. **PULSE Broadcasting**: The active `ROOT` node periodically broadcasts a `PULSE` message containing its current term counter.
2. **Heartbeat Timeout**: If a `SHADOW` node fails to receive a `PULSE` within `calculate_timeout()` multiplied by RTT heuristics, it increments the term count and transitions to `ROOT`.
3. **Dual-Root Conflict Resolution**: If two nodes claim `ROOT` status for the same term, authority is resolved deterministically by comparing cryptographic identifiers using string locale comparison (`a.localeCompare(b) < 0`). The loser instantly downgrades to `SHADOW`.

---

## Message Routing & Network Heuristics

### Weighted K-Best Forwarding (W-KBF)

When relaying control frames, `TorrentPeerContext` avoids flood broadcasting by ranking peers using real-time WebRTC stats:

$$\text{Cost} = \text{RTT} \cdot 1000 + \text{PLR} \cdot 5000 + \text{Jitter} \cdot 1000 + \frac{1}{\text{AOB} + 1}$$

- **Distance Smoothing**: Updated continuously using Exponential Moving Average (EMA):
  $$\text{Distance}_{t} = \alpha \cdot \text{Cost} + (1 - \alpha) \cdot \text{Distance}_{t-1} \quad (\alpha = 0.1)$$
- **Candidate Selection Size**: Messages are forwarded to the top $k$ candidates:
  $$k = \lceil \sqrt{N} \rceil \quad \text{where } N = \text{connected peers count}$$

### Exchange Routing Modes

1. **Direct (`direct`)**: Messages are delivered to furrows matching the exact routing key.
2. **Fanout (`fanout`)**: Messages are blindly broadcast to all child furrows under the seeder.
3. **Topic (`topic`)**: AMQP-style routing key wildcard matching:
   - `.` delimits string segments.
   - `*` matches exactly one word segment.
   - `#` matches zero or more word segments.

---

## Internal Contexts

### TorrentPeerContext
Tracks cluster states (`connected_peers`), manages the de-duplication LRU cache (`store`), signs control payloads, and routes candidate streams.

### TorrentSeederContext
Manages exchange state machine transitions (`ROOT`, `SHADOW`, `WAITING`), handles `SWARM_KEY_REFRESH`, and coordinates ephemeral ECDH handshakes for key distribution.

### TorrentFurrowContext
Handles queue-level subscriptions, executes pattern-matching algorithms, verifies payload HMAC signatures, decrypts message bodies, and dispatches callbacks.

---

## Utility & Helper Classes

- **TorrentUtils**:
  - `to_array_buffer(value)` / `from_array_buffer(buffer)`: Advanced binary serializer supporting primitives, circular references, `Map`, `Set`, `TypedArray`, `Date`, `RegExp`, `BigInt`, and `ArrayBuffer`.
  - `encrypt(data, key)` / `decrypt(data, key)`: AES-GCM binary encryption and decryption.
  - `_get_connection_cost(pc)`: Extracts RTT, packet loss ratio (PLR), jitter, and available outgoing bitrate (AOB) from WebRTC stats.
  - `calculate_timeout(peer_map)`: Computes adaptive cluster failover timeouts based on current network metrics.
- **TorrentEphemeral**: Wraps ECDH key generation to establish ephemeral, non-extractable session keys.
- **TorrentEmitter**: Lightweight, generic type-safe event emitter base class.
- **TorrentError**: Specialized exception type for mesh network failures.

---

## Type Reference

```typescript
export type TorrentMessageBody =
  | Uint8Array
  | string
  | number
  | boolean
  | object
  | null;

export type TorrentMessageHeaders = {
  hop_count?: number;
  source?: string;
  schema_version?: string;
  retry_count?: number;
  re_delivered?: boolean;
};

export type TorrentMessageProperties = {
  headers?: TorrentMessageHeaders;
  routing_key?: string;
  content_type?: string;
  message_id?: string;
  body_size?: number;
  ttl?: number;
};

export type TorrentPeerQuality =
  | "EXCELLENT"
  | "GOOD"
  | "FAIR"
  | "POOR"
  | "BAD"
  | "DEAD";

export type TorrentSeederParams = {
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
  key_refresh?: number;
  type?: "direct" | "topic" | "fanout";
  internal?: boolean;
  args?: Record<string, unknown>;
};

export type TorrentFurrowParams = {
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
  key_refresh?: number;
  exclusive?: boolean;
  routing_keys?: string[];
  args?: Record<string, unknown>;
};

export type TorrentConsumeParams = {
  tag?: string;
  no_ack?: boolean;
  exclusive?: boolean;
};

export type TorrentSubscription = {
  unplant(): void;
};
```

---

## Configuration & Constants

Internal network behavior is governed by defaults defined in `torrent-consts.ts`:

| Constant | Default Value | Description |
| --- | --- | --- |
| `TORRENT_PORT` | `8765` | Default port used for WebSocket signalling servers. |
| `MIN_FAILOVER_TIMEOUT` | `2000` | Minimum failover threshold in milliseconds. |
| `FAILOVER_RTT_MULTIPLIER` | `5` | Multiplier applied to cluster RTT when computing heartbeat tolerances. |

```
```
