import { TorrentIdentity } from "./torrent-identity";
import { TorrentMessage } from "./torrent-message";

export type TorrentSeederFurrowMode = "master" | "shadow";

export type TorrentSeederFurrowSecurityObject = {
  identifier: string;
  identity: TorrentIdentity;
  pub_key: JsonWebKey;
  swarm_key: ArrayBuffer;
};

type SeederFurrowSharedParams = {
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
  key_refresh?: number;
};

export type TorrentSeederParams = SeederFurrowSharedParams & {
  type?: "direct" | "topic" | "fanout";
  internal?: boolean;
  args?: Record<string, any>;
};

export type TorrentFurrowParams = SeederFurrowSharedParams & {
  exclusive?: boolean;
  auto_bind?: boolean;
  auto_plant?: boolean;
};

export type TorrentConsumeParams = {
  tag?: string;
  no_ack?: boolean;
  exclusive?: boolean;
};

export type TorrentCallBack = (message: TorrentMessage) => void;

export type TorrentAckCallBack = (data: any) => void;

export type TorrentMessageObject = {
  body: TorrentMessageBody;
  properties?: TorrentMessageProperties;
  artifacts: {
    mac: string; // message authentication code for the message body and properties
    pub_key: JsonWebKey;
    timestamp: number;
    signature: string;
  };
};

export type TorrentMessageObjectWithoutSig = Omit<
  TorrentMessageObject,
  "artifacts"
> & {
  artifacts: Omit<TorrentMessageObject["artifacts"], "signature" | "pub_key">;
};

export type TorrentMessageBody =
  | Uint8Array
  | string
  | number
  | boolean
  | object
  | null;

export type TorrentMessageHeaders = {
  hop_count?: number;
  content_type?: string;
  retry_count?: number;
};

export type TorrentMessageProperties = {
  headers?: TorrentMessageHeaders;
  routing_key?: string;
  message_id?: string;
  re_delivered?: boolean;
  body_size?: number;
};

export type TorrentMessageParams = {
  routing_key?: string;
  on_ack?: TorrentAckCallBack;
};

export type TorrentEventName =
  | "peer_connected"
  | "peer_disconnected"
  | "bind"
  | "unbind"
  | "peer_bind"
  | "peer_unbind"
  | "publish"
  | "message_receive"
  | "found"
  | "not_found"
  | "connected_remote_seeder"
  | "message_malformed"
  | "ack";

export type TorrentControlSeederOrFurrow = {
  id: string;
  name: string;
};

export type TorrentControlFurrow = TorrentControlSeederOrFurrow & {
  pub_key: JsonWebKey;
};

export type TorrentControlOriginSeeder = TorrentControlSeederOrFurrow & {
  pub_key: JsonWebKey;
};

export type TorrentControlCertifiedSeeder = TorrentControlSeederOrFurrow & {
  cert: TorrentSeederCertificate;
};

export type TorrentControlSeeder =
  | TorrentControlOriginSeeder
  | TorrentControlCertifiedSeeder;

export type TorrentControlBindFurrow = TorrentControlSeederOrFurrow & {
  routing_key?: string;
};

type TorrentControlPeerInfo = {
  control_id: string;
  from: string;
  to?: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlSeederOrFurrow;
  artifacts: {
    pub_key: JsonWebKey;
    timestamp: number;
    signature: string;
  };
};

type TorrentControlPeerBindInfo = {
  control_id: string;
  from: string;
  to?: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlBindFurrow;
};

export type TorrentSeederCertificate = {
  pub_key: string;
  exp: number;
  scope: {
    seeder: TorrentControlSeeder;
    furrow?: TorrentControlFurrow;
  };
  perms: TorrentSeederPermissions[];
  signature: string;
};

type TorrentSeederPermissions = "sign" | "verify";

export type TorrentControlMessage =
  | (TorrentControlPeerBindInfo & { type: "ANNOUNCE_BIND" })
  | (TorrentControlPeerBindInfo & { type: "ANNOUNCE_UNBIND" })
  | (TorrentControlPeerInfo & {
      type: "PUBLISH";
      message: TorrentMessageObject;
      seeder: TorrentControlSeeder;
      furrow?: TorrentControlFurrow;
    })
  | (TorrentControlPeerInfo & {
      type: "SUBMIT";
      message: TorrentMessageObjectWithoutSig;
    })
  | (TorrentControlPeerInfo & { type: "ACK"; message_id: string })
  | (TorrentControlPeerInfo & { type: "FIND" })
  | (TorrentControlPeerInfo & { type: "NOT_FOUND" })
  | (TorrentControlPeerInfo & {
      seeder: TorrentHostedObj;
      furrow?: TorrentHostedObj;
      type: "FOUND";
    })
  // key shit for exchange (seeder <-> peer)
  // routes through the peer hosting the seeder
  // it'll be a miracle if this works
  // 24th April 2026 : it did fucking work, lol
  | (TorrentControlPeerInfo & { type: "SWARM_KEY_REFRESH" })
  | (TorrentControlPeerInfo & {
      type: "EPH_KEY_OFFER";
      eph_pub_key: string;
    })
  | (TorrentControlPeerInfo & {
      type: "EPH_KEY_EXCHANGE";
      eph_pub_key: string; // ur own ephemeral public key
      key_sig: {
        eph_pub_key: string; // the ephemeral public key you signed
        signature: string;
        identity_pub_key: JsonWebKey;
      };
      encrypted: {
        aes_salt: string;
        swarm_key: string;
      };
    })
  // this is part of my latest hallucinations
  // can't wait for this to fail terribly
  | (TorrentControlPeerInfo & { type: "PULSE" })
  // yay synced storage (this does fuck all me finks)
  // im kidding it is actually so useful for de-dups
  // and ignoring any old messages still in a loop
  | {
      control_id: string;
      from: string;
      to: string;
      type: "LRU_STORE";
      message: TorrentControlMessage;
    };

export type TorrentSignalMessage =
  | { type: "HELO"; from: string }
  | { type: "HIHI"; from: string; to: string }
  | { type: "YOYO"; from: string; to?: string } // used instead of HELO and HIHI for partition recovery
  | { type: "BYE"; from: string; to?: string }
  | { type: "OFFER"; from: string; to?: string; sdp: RTCSessionDescription }
  | { type: "ANSWER"; from: string; to: string; sdp: RTCSessionDescription }
  | { type: "ICE"; from: string; to?: string; candidate: RTCIceCandidateInit }
  | {
      type: "STATUS";
      from: string;
      to?: string;
      stats?: {
        plr?: number;
        rtt?: number;
        accepting_connections?: boolean;
        connected_peers?: string[];
      };
    };

export type TorrentSignalEventMessage =
  | { type: "SIGNALLER_CONNECTED"; ident: string; url: string }
  | { type: "SIGNALLER_DISCONNECTED"; ident: string; url: string };

export type TorrentPeerQuality =
  | "EXCELLENT"
  | "GOOD"
  | "FAIR"
  | "POOR"
  | "BAD"
  | "DEAD";

export type TorrentPeerEntry = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  bb?: TorrentBrokerBindings;
  ice_queue?: RTCIceCandidateInit[];
  making_offer?: boolean;
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

export type TorrentBrokerBindings = Map<
  TorrentSeederBindingBrand,
  Set<TorrentFurrowBindingBrand>
>;

export type TorrentBrokerHost = Map<
  TorrentHostedBrand,
  Set<TorrentHostedBrand>
>;

type TorrentBrand<K, T> = K & { readonly __brand: T };

export type TorrentSeederBindingBrand = TorrentBrand<
  string,
  "SeederBindingKey"
>;
export type TorrentFurrowBindingBrand = TorrentBrand<
  string,
  "FurrowBindingKey"
>;

export type TorrentSeederBindingObj =
  | {
      id: string;
      name: string;
      pub_key?: JsonWebKey;
      swarm_key?: ArrayBuffer;
    }
  | {
      id: string;
      name: string;
      cert?: TorrentSeederCertificate;
      swarm_key?: ArrayBuffer;
    };

export type TorrentFurrowBindingObj = {
  id: string;
  name: string;
  pub_key?: JsonWebKey;
  routing_key: string;
};

export type TorrentHostedBrand = TorrentBrand<string, "HostedObj">;

export type TorrentHostedObj =
  | {
      id: string;
      name: string;
      pub_key: JsonWebKey;
      cert?: TorrentSeederCertificate;
      properties?: TorrentSeederParams | TorrentFurrowParams;
    }
  | {
      id: string;
      name: string;
      pub_key?: never;
      cert: TorrentSeederCertificate;
      properties?: TorrentSeederParams | TorrentFurrowParams;
    };

export type TorrentSerializableOrDeserializableBindingObj =
  | TorrentSeederBindingObj
  | TorrentFurrowBindingObj;

export type TorrentSerializableOrDeserializableBindingKey =
  | TorrentSeederBindingBrand
  | TorrentFurrowBindingBrand;

export type TorrentDeserializableHostedObjOf<K extends TorrentHostedBrand> =
  K extends TorrentHostedBrand ? TorrentHostedObj : never;

export type TorrentDeserializableBindingObjOf<
  K extends TorrentSerializableOrDeserializableBindingKey,
> = K extends TorrentFurrowBindingBrand
  ? TorrentFurrowBindingObj
  : K extends TorrentSeederBindingBrand
    ? TorrentSeederBindingObj
    : never;

export type TorrentSerializableHostedKeyOf<T extends TorrentHostedObj> =
  T extends TorrentHostedObj ? TorrentHostedBrand : never;

export type TorrentSerializableBindingKeyOf<
  T extends TorrentSerializableOrDeserializableBindingObj,
> = T extends TorrentFurrowBindingObj
  ? TorrentFurrowBindingBrand
  : T extends TorrentSeederBindingObj
    ? TorrentSeederBindingBrand
    : never;

// for converting to and from array buffers

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
