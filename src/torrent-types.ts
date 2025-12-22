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
      seeder: TorrentControlSeederOrFurrow & { public_key: JsonWebKey };
      artifacts: {
        timestamp: number;
        signature: string;
      };
    })
  | (TorrentControlPeerInfo & {
      type: "SUBMIT";
      message?: TorrentMessageObject;
      seeder: TorrentControlSeederOrFurrow;
    })
  | (TorrentControlPeerInfo & { type: "ACK"; message_id: string })
  | (TorrentControlPeerInfo & { type: "FIND" })
  | (TorrentControlPeerInfo & { type: "NOT_FOUND" })
  | (TorrentControlPeerInfo & {
      type: "CREATE_FURROW_ON_HOST";
      furrow: { name: string };
    })
  | (TorrentControlPeerInfo & { type: "FURROW_CREATED_ON_HOST" })
  | {
      control_id: string;
      from: string;
      to?: string;
      seeder: TorrentSeederHostedObj & { public_key: JsonWebKey };
      furrow?: TorrentFurrowHostedObj;
      type: "FOUND";
    }
  | {
      type: "MIGRATE";
      from: string;
      to?: string;
      control_id: string;
      migration_key: string;
      migration_object: {
        seeder: TorrentControlSeederOrFurrow;
        furrows: TorrentControlSeederOrFurrow[];
      }[];
      timestamp?: number;
    }
  | {
      type: "MIGRATION_COMPLETE";
      from: string;
      control_id: string;
      migration_key: string;
    }
  | { type: "MAX_CAPACITY"; from: string; control_id: string };

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

// PLEASE DO NOT TOUCH
// IT IS A MIRACLE THAT IT WORKS

type TorrentBrand<K, T> = K & { readonly __brand: T };

export type TorrentSeederBindingBrand = TorrentBrand<string, "SeederKey">;
export type TorrentFurrowBindingBrand = TorrentBrand<string, "FurrowKey">;

export type TorrentSeederBindingObj = {
  s_id: string;
  name: string;
  public_key?: JsonWebKey;
};

export type TorrentFurrowBindingObj = {
  f_id: string;
  name: string;
  routing_key: string;
};

// map [seeder_id, seeder_name, seeder_publick_key] -> [furrow_id, furrow_name, routing_key][]
export type TorrentBrokerBindings = Map<
  TorrentSeederBindingBrand,
  Set<TorrentFurrowBindingBrand>
>;

export type TorrentSeederHostedBrand = TorrentBrand<string, "SeederHostedObj">;
export type TorrentFurrowHostedBrand = TorrentBrand<string, "FurrowHostedObj">;

// distinguish seeder and furrow `name` to avoid branding issues
export type TorrentSeederHostedObj = {
  id: string;
  s_name: string;
  public_key: JsonWebKey;
  properties?: TorrentSeederParams;
};

export type TorrentFurrowHostedObj = {
  id: string;
  f_name: string;
  properties?: TorrentFurrowParams;
};

export type TorrentBrokerHost = Map<
  TorrentSeederHostedBrand,
  Set<TorrentFurrowHostedBrand>
>;

export type TorrentSerializableObj =
  | TorrentFurrowHostedObj
  | TorrentSeederHostedObj
  | TorrentFurrowBindingObj
  | TorrentSeederBindingObj;

export type TorrentDeserializableKey =
  | TorrentFurrowHostedBrand
  | TorrentSeederHostedBrand
  | TorrentFurrowBindingBrand
  | TorrentSeederBindingBrand;

// deserialization mapping
export type TorrentDeserializeObjOf<K extends TorrentDeserializableKey> =
  K extends TorrentSeederBindingBrand
    ? TorrentSeederBindingObj
    : K extends TorrentFurrowBindingBrand
      ? TorrentFurrowBindingObj
      : K extends TorrentSeederHostedBrand
        ? TorrentSeederHostedObj
        : K extends TorrentFurrowHostedBrand
          ? TorrentFurrowHostedObj
          : never;

// serialization mapping
export type TorrentSerializeKeyOf<T extends TorrentSerializableObj> =
  T extends TorrentSeederBindingObj
    ? TorrentSeederBindingBrand
    : T extends TorrentFurrowBindingObj
      ? TorrentFurrowBindingBrand
      : T extends TorrentSeederHostedObj
        ? TorrentSeederHostedBrand
        : T extends TorrentFurrowHostedObj
          ? TorrentFurrowHostedBrand
          : never;
