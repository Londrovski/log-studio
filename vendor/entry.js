// Everything the app needs from npm, bundled so there is no CDN at runtime.
// Rebuild with: npm run build
import { McapIndexedReader } from "@mcap/core";
import protobuf from "protobufjs";
// Importing the descriptor extension adds Root.fromDescriptor as a side effect,
// and exports the google.protobuf namespace itself.
import descriptorNs from "protobufjs/ext/descriptor/index.js";
import { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, Quality, getFirstEncodableVideoCodec } from "mediabunny";
import wasmZstd from "@foxglove/wasm-zstd";
import * as fzstd from "fzstd";
import lz4 from "lz4js";

const FileDescriptorSet = descriptorNs.lookupType("FileDescriptorSet");

// TBRe logs are written by python mcap with zstd chunk compression, and the MCAP core
// library deliberately ships no codecs, so we supply them.
//
// zstd runs as WebAssembly, which matters more than it sounds: a three-minute run holds
// about 320 MB of compressed chunks, and the pure-JS decoder manages ~19 MB/s against
// WebAssembly's several hundred. That is the difference between a run opening in a
// second and in twenty. fzstd stays as the fallback for the moment before the wasm
// finishes loading, or if it fails to load at all.
let wasmReady = false;
export const zstdReady = wasmZstd.isLoaded.then(() => { wasmReady = true; }).catch(() => { wasmReady = false; });

const decompressHandlers = {
  zstd: (buffer, decompressedSize) =>
    wasmReady
      ? wasmZstd.decompress(buffer, Number(decompressedSize))
      : fzstd.decompress(buffer, new Uint8Array(Number(decompressedSize))),
  lz4: (buffer, decompressedSize) => new Uint8Array(lz4.decompress(buffer, Number(decompressedSize))),
};

export { McapIndexedReader, protobuf, FileDescriptorSet, decompressHandlers, Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, Quality, getFirstEncodableVideoCodec };
