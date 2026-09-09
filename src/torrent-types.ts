import { TorrentMessage } from "./torrent-message";

export type TorrentMessageBody =
  Uint8Array | string | number | boolean | object | null;

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

export type TorrentMessageParams = {
  source: string;
  routing_key?: string;
  ttl?: number;
  on_ack?: TorrentAckCallback;
};

export type TorrentMessageObject = {
  body: TorrentMessageBody;
  properties?: TorrentMessageProperties;
  artifacts: {
    mac: string; // message authentication code for the message body and properties
    public_key: JsonWebKey;
    timestamp: number;
    signature: string;
  };
};

export type TorrentCallback = (message: TorrentMessage) => void;
export type TorrentAckCallback = (data: any) => void;

export type TorrentWebSocketUrl = `${"ws" | "wss"}://${string}`;

type TorrentSignalBase = {
  message_id: string;
  from: string;
  to?: string; // optional by default
};

export type TorrentSignalMessage =
  | (TorrentSignalBase & { type: "HELO" })
  | (TorrentSignalBase & { type: "HIHI"; to: string })
  | (TorrentSignalBase & { type: "BYE" })
  | (TorrentSignalBase & { type: "OFFER"; sdp: RTCSessionDescription })
  | (TorrentSignalBase & {
      type: "ANSWER";
      to: string;
      sdp: RTCSessionDescription;
    })
  | (TorrentSignalBase & { type: "ICE"; candidate: RTCIceCandidate });

export type TorrentPeerOptions = {
  min_cluster_size?: number;
  max_cluster_size?: number;
  stats_refresh_interval?: number;
  partion_heal_interval?: number;
};

export type TorrentPeerQuality =
  "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "BAD" | "DEAD";

export type TorrentPeerEntry = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  // ice_queue?: RTCIceCandidateInit[];
  // making_offer?: boolean;
  stats?: {
    cost?: number;
    rtt?: number; // round trip time
    plr?: number; // packet loss ratio
    jitter?: number;
    aob?: number; // available outgoing bitrate
    distance?: number;
    quality?: TorrentPeerQuality;
  };
};

export type TorrentControlSeederOrFurrow = {
  id: string;
  name: string;
  public_key: JsonWebKey;
};

type TorrentControlPeerInfo = {
  control_id: string;
  from: string;
  to?: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlSeederOrFurrow;
  artifacts: {
    public_key: JsonWebKey;
    timestamp: number;
    signature: string;
  };
};

export type TorrentControlMessage =
  | (TorrentControlPeerInfo & {
      type: "PUBLISH";
      message: TorrentMessageObject;
      seeder: TorrentControlSeederOrFurrow;
      furrow?: TorrentControlSeederOrFurrow;
    })
  | (TorrentControlPeerInfo & { type: "ACK"; message_id: string });

type SeederFurrowSharedParams = {
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
  // key_refresh?: number;
  args?: Record<string, unknown>;
};

export type TorrentSeederParams = SeederFurrowSharedParams & {
  type?: "direct" | "topic" | "fanout";
  internal?: boolean;
};

export type TorrentFurrowParams = SeederFurrowSharedParams & {
  exclusive?: boolean;
  routing_keys?: string[];
};

export type TorrentConsumeParams = {
  tag?: string;
  no_ack?: boolean;
  exclusive?: boolean;
};

export type TorrentSubscription = {
  unplant(): void;
};

// Additional types

export type KeyFormat = "raw" | "pkcs8" | "spki" | "jwk";

type PrimitiveNode =
  | { t: "null" }
  | { t: "undef" }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "nan" }
  | { t: "inf" }
  | { t: "-inf" }
  | { t: "bigint"; v: string };

type RefNode = { t: "ref"; v: number };

type DateNode = { t: "date"; v: string; id: number };
type RegexNode = { t: "regex"; v: [string, string]; id: number };
type MapNode = { t: "map"; v: [Node, Node][]; id: number };
type SetNode = { t: "set"; v: Node[]; id: number };
type TypedArrayNode = { t: "typed"; c: string; v: number[]; id: number };
type ArrayBufferNode = { t: "arraybuffer"; v: number[]; id: number };
type ArrayNode = { t: "arr"; v: Node[]; id: number };
type ObjectNode = { t: "obj"; v: Record<string, Node>; id: number };

export type Node =
  | PrimitiveNode
  | RefNode
  | DateNode
  | RegexNode
  | MapNode
  | SetNode
  | TypedArrayNode
  | ArrayBufferNode
  | ArrayNode
  | ObjectNode;
