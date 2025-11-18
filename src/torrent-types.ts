import { TorrentFurrow } from "./torrent-furrow";
import { TorrentMessage } from "./torrent-message";
import { TorrentPeer } from "./torrent-peer";
import { TorrentSeeder } from "./torrent-seeder";

type SeederFurrowSharedParams = {
  passive?: boolean;
  durable?: boolean;
  auto_delete?: boolean;
  auto_plant?: boolean;
};

export type TorrentSeederParams = SeederFurrowSharedParams & {
  type?: "direct" | "topic" | "fanout";
  internal?: boolean;
  args?: Record<string, any>;
};

export type TorrentFurrowParams = SeederFurrowSharedParams & {
  exclusive?: boolean;
  auto_bind?: boolean;
};

export type TorrentConsumeParams = {
  tag?: string;
  no_ack?: boolean;
  exclusive?: boolean;
  args?: Record<string, any>;
};

export type TorrentCallBack = (message: TorrentMessage) => void;

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

export type TorrentMessageProperties = {
  headers?: Record<string, any>;
  routing_key?: string;
  message_id?: string;
  re_delivered?: boolean;
  body_size?: number;
};

export type TorrentMessageParams = {
  routing_key?: string;
  on_ack?: TorrentCallBack;
};

export type TorrentControlSeederOrFurrow = {
  id: string;
  name: string;
};

type TorrentControlPeerInfo = {
  peer_id: string;
  seeder: TorrentControlSeederOrFurrow;
  furrow?: TorrentControlSeederOrFurrow;
};

export type TorrentControlMessage =
  | (TorrentControlPeerInfo & { type: "ANNOUNCE_BIND" })
  | (TorrentControlPeerInfo & { type: "ANNOUNCE_UNBIND" })
  | (TorrentControlPeerInfo & {
      type: "PUBLISH";
      message?: TorrentMessageObject;
    })
  | (TorrentControlPeerInfo & { type: "FIND" })
  | (TorrentControlPeerInfo & { type: "FOUND" })
  | { type: "ACK"; peer_id: string; message_id: string };

// Signal message for WebRTC
export type TorrentSignalMessage =
  | { type: "OFFER"; from: string; to?: string; sdp: RTCSessionDescriptionInit }
  | { type: "ANSWER"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "ICE"; from: string; to?: string; candidate: RTCIceCandidateInit }
  | {
      type: "RELAY_CONTROL";
      from: string;
      to?: string;
      control: TorrentControlMessage;
    };

export type TorrentSignalHandler = (msg: TorrentSignalMessage) => void;

export type TorrentSignalOpts = { auto_connect?: boolean };

export type TorrentPeerEntry = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
};
