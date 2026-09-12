// Reading TBRe .mcap logs in the browser.
//
// Two things here are not obvious:
//  1. MCAP wants random access, and a browser File gives us that through .slice(),
//     so we never load a 200 MB log into memory.
//  2. Foxglove's SDK writes protobuf schemas that mark proto3 fields `required`,
//     which proto3 forbids. Every standard decoder refuses them. We relax the flag
//     before building the type, exactly as the team's crop_mcap.py does.

import { McapIndexedReader, protobuf, FileDescriptorSet, decompressHandlers } from "../../vendor/bundle.js";

const LABEL_REQUIRED = 2;
const LABEL_OPTIONAL = 1;

export const readableFromFile = (file) => ({
  size: async () => BigInt(file.size),
  read: async (offset, length) =>
    new Uint8Array(await file.slice(Number(offset), Number(offset) + Number(length)).arrayBuffer()),
});

function relaxRequired(messageType) {
  for (const f of messageType.field ?? []) {
    if (f.label === LABEL_REQUIRED) f.label = LABEL_OPTIONAL;
  }
  for (const n of messageType.nestedType ?? []) relaxRequired(n);
}

export class LogReader {
  constructor(file, reader) {
    this.file = file;
    this.reader = reader;
    this._types = new Map(); // schemaId -> protobuf Type
  }

  static async open(file) {
    const reader = await McapIndexedReader.Initialize({ readable: readableFromFile(file), decompressHandlers });
    return new LogReader(file, reader);
  }

  /** Channels, keyed by topic. */
  get channels() {
    if (!this._channels) {
      this._channels = new Map();
      for (const c of this.reader.channelsById.values()) this._channels.set(c.topic, c);
    }
    return this._channels;
  }

  get topics() {
    return [...this.channels.keys()].sort();
  }

  /** Log start and end, in seconds. */
  get span() {
    const s = this.reader.statistics;
    return { start: Number(s.messageStartTime) / 1e9, end: Number(s.messageEndTime) / 1e9 };
  }

  get messageCount() {
    return Number(this.reader.statistics?.messageCount ?? 0);
  }

  /** How many messages each topic holds — the cheap way to see what a log contains. */
  get countsByTopic() {
    const out = new Map();
    const counts = this.reader.statistics?.channelMessageCounts;
    if (counts) {
      for (const [id, n] of counts) {
        const ch = this.reader.channelsById.get(Number(id));
        if (ch) out.set(ch.topic, Number(n));
      }
    }
    return out;
  }

  typeFor(schemaId) {
    if (this._types.has(schemaId)) return this._types.get(schemaId);
    const schema = this.reader.schemasById.get(schemaId);
    if (!schema) return null;
    let type = null;
    if (schema.encoding === "protobuf") {
      const set = FileDescriptorSet.decode(schema.data);
      for (const file of set.file ?? []) for (const mt of file.messageType ?? []) relaxRequired(mt);
      type = protobuf.Root.fromDescriptor(set).lookupType(schema.name);
    }
    this._types.set(schemaId, type);
    return type;
  }

  /** Decode one raw MCAP record into a plain object. */
  decode(msg) {
    const ch = this.reader.channelsById.get(msg.channelId);
    if (!ch) return null;
    if (ch.messageEncoding === "json") return JSON.parse(new TextDecoder().decode(msg.data));
    const type = this.typeFor(ch.schemaId);
    return type ? type.decode(msg.data) : null;
  }

  /**
   * Walk messages on the given topics.
   * Yields { topic, time (seconds), value (decoded), raw }.
   */
  async *read(topics, { start, end } = {}) {
    const opts = { topics };
    if (start != null) opts.startTime = BigInt(Math.round(start * 1e9));
    if (end != null) opts.endTime = BigInt(Math.round(end * 1e9));
    for await (const msg of this.reader.readMessages(opts)) {
      const ch = this.reader.channelsById.get(msg.channelId);
      yield { topic: ch?.topic, time: Number(msg.logTime) / 1e9, value: this.decode(msg), raw: msg };
    }
  }
}
