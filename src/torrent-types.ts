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
  peer_id: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlSeederOrFurrow;
};

type TorrentControlPeerBindInfo = {
  control_id: string;
  peer_id: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlBindFurrow;
};

export type TorrentControlMessage =
  | (TorrentControlPeerBindInfo & { type: "ANNOUNCE_BIND" })
  | (TorrentControlPeerBindInfo & { type: "ANNOUNCE_UNBIND" })
  | (TorrentControlPeerInfo & {
      type: "PUBLISH";
      message?: TorrentMessageObject;
      remaining_targets?: string[];
    })
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
  | { type: "STATUS"; from: string; peers: Map<string, TorrentPeerEntry> };

export type TorrentRTCMessage = {
  type: "RELAY_CONTROL";
  from: string;
  to?: string;
  control: TorrentControlMessage;
};

export type TorrentSignalHandler = (msg: TorrentSignalMessage) => void;

// map [seeder_id, seeder_name] -> [furrow_id, furrow_name, routing_key][]
export type TorrentBrokerBindings = Map<
  [string, string],
  Set<[string, string, string]>
>;

export type TorrentPeerEntry = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  bb?: TorrentBrokerBindings;
  ice_queue?: RTCIceCandidateInit[];
  making_offer?: boolean;
  israp?: boolean; // is setting remote answer pending
  cost?: number;
};
