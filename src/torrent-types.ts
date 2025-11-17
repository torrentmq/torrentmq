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

export type TorrentControlMessage =
  | {
      type: "ANNOUNCE_BIND";
      peer_id: string;
      seeder_id: string;
      furrow_id?: string;
    }
  | {
      type: "ANNOUNCE_UNBIND";
      peer_id: string;
      seeder_id: string;
      furrow_id?: string;
    }
  | {
      type: "PUBLISH";
      peer_id: string;
      seeder_id: string;
      furrow_id?: string;
      message?: TorrentMessageObject;
    }
  | {
      type: "FIND";
      peer_id: string;
      seeder_name: string;
      furrow_name: string;
    }
  | { type: "ACK"; peer_id: string; message_id: string };

export type TorrentSignalMessage =
  | { type: "OFFER"; from: string; to?: string; sdp: RTCSessionDescriptionInit }
  | { type: "ANSWER"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "ICE"; from: string; to?: string; candidate: RTCIceCandidateInit }
  | {
      type: "RELAY_CONTROL";
      from: string;
      to?: string;
      control: TorrentControlMessage;
    }
  | {
      type: "FIND";
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
