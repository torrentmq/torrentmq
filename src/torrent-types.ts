import { TorrentMessage } from "./torrent-message";

type SeederFurrowSharedParams = {
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
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
  body?: TorrentMessageBody;
  properties?: TorrentMessageProperties;
} & Pick<TorrentMessageParams, "on_ack">;

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
  | "PEER_CONNECTED"
  | "PEER_DISCONNECTED"
  | "BIND"
  | "UNBIND"
  | "PEER_BIND"
  | "PEER_UNBIND"
  | "PUBLISH"
  | "MESSAGE_RECEIVE"
  | "FOUND"
  | "NOT_FOUND"
  | "ACK";

export type TorrentControlSeederOrFurrow = {
  id: string;
  name: string;
};

export type TorrentControlBindFurrow = TorrentControlSeederOrFurrow & {
  routing_key?: string;
};

type TorrentControlPeerInfo = {
  control_id: string;
  from: string;
  to?: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlSeederOrFurrow;
};

type TorrentControlPeerBindInfo = {
  control_id: string;
  from: string;
  to?: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlBindFurrow;
};

export type TorrentControlMessage =
  | (TorrentControlPeerBindInfo & { type: "ANNOUNCE_BIND" })
  | (TorrentControlPeerBindInfo & { type: "ANNOUNCE_UNBIND" })
  | (TorrentControlPeerInfo & {
      type: "PUBLISH";
      message?: TorrentMessageObject;
    })
  | (TorrentControlPeerInfo & { type: "MIGRATE" })
  | (TorrentControlPeerInfo & { type: "FIND" })
  | (TorrentControlPeerInfo & { type: "FOUND" })
  | (TorrentControlPeerInfo & { type: "NOT_FOUND" })
  | (TorrentControlPeerInfo & { type: "ACK"; message_id: string });

// Signal message for WebRTC
export type TorrentSignalMessage =
  | { type: "HELO"; from: string }
  | { type: "HIHI"; from: string; to: string }
  | { type: "SIGNALLER"; identifier: string }
  | { type: "OFFER"; from: string; to?: string; sdp: RTCSessionDescriptionInit }
  | { type: "ANSWER"; from: string; to: string; sdp: RTCSessionDescriptionInit }
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

export type TorrentRTCMessage = {
  type: "RELAY_CONTROL";
  from: string;
  to?: string;
  control: TorrentControlMessage;
};

export type TorrentSignalHandler = (msg: TorrentSignalMessage) => void;

type TorrentBrand<K, T> = K & { readonly __brand: T };

export type TorrentSeederKey = TorrentBrand<string, "SeederKey">;
export type TorrentFurrowKey = TorrentBrand<string, "FurrowKey">;

export type TorrentSeederTuple = readonly [string, string];
export type TorrentFurrowTuple = readonly [string, string, string];

// map [seeder_id, seeder_name] -> [furrow_id, furrow_name, routing_key][]
export type TorrentBrokerBindings = Map<
  TorrentSeederKey,
  Set<TorrentFurrowKey>
>;

export type TorrentBindingTuple = TorrentSeederTuple | TorrentFurrowTuple;
// Union type of all keys
export type TorrentBindingKey = TorrentSeederKey | TorrentFurrowKey;

// Helper type to map tuple -> key
export type TorrentBindingKeyOf<T extends TorrentBindingTuple> =
  T extends TorrentSeederTuple
    ? TorrentSeederKey
    : T extends TorrentFurrowTuple
      ? TorrentFurrowKey
      : never;

// Helper type to map key -> tuple
export type TorrentBindingTupleOf<K extends TorrentBindingKey> =
  K extends TorrentSeederKey
    ? TorrentSeederTuple
    : K extends TorrentFurrowKey
      ? TorrentFurrowTuple
      : never;

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
  israp?: boolean; // is setting remote answer pending
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
