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
  ttl?: string;
  on_ack?: TorrentAckCallback;
};

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
  | (TorrentSignalBase & { type: "ICE"; candidate: RTCIceCandidate })
  | (TorrentSignalBase & {
      type: "STATUS";
      stats?: {
        plr?: number;
        rtt?: number;
        accepting_connections?: boolean;
        connected_peers?: string[];
      };
    });

export type TorrentPeerOptions = {
  min_cluster_size?: number;
  max_cluster_size?: number;
  status_frequency?: number;
  partion_heal_interval?: number;
};

export type TorrentPeerQuality =
  "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "BAD" | "DEAD";

export type TorrentPeerEntry = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  // bb?: TorrentBrokerBindings;
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
  pub_key: JsonWebKey;
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

export type TorrentControlMessage =
  | (TorrentControlPeerInfo & {
      type: "PUBLISH";
      message: TorrentMessageObject;
      seeder: TorrentControlSeederOrFurrow;
      furrow?: TorrentControlSeederOrFurrow;
    })
  | (TorrentControlPeerInfo & { type: "ACK"; message_id: string });
