/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { TagLib } from "../src/taglib.ts";
import { join } from "@std/path";
import {
  type BackendAdapter,
  forEachBackend,
} from "./backend-adapter.ts";

describe("Codec Detection", () => {
  it("MP3 - both container and codec", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const mp3Path = join("tests", "test-files", "mp3", "kiss-snippet.mp3");
    const mp3Buffer = await Deno.readFile(mp3Path);
    const file = await taglib.open(mp3Buffer);

    try {
      const props = file.audioProperties();
      assertEquals(props?.containerFormat, "MP3");
      assertEquals(props?.codec, "MP3");
      assertEquals(props?.isLossless, false);
      assertEquals(props?.bitsPerSample, 0);
    } finally {
      file.save();
      file.dispose();
    }
  });

  it("FLAC - both container and codec", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const flacPath = join("tests", "test-files", "flac", "kiss-snippet.flac");
    const flacBuffer = await Deno.readFile(flacPath);
    const file = await taglib.open(flacBuffer);

    try {
      const props = file.audioProperties();
      assertEquals(props?.containerFormat, "FLAC");
      assertEquals(props?.codec, "FLAC");
      assertEquals(props?.isLossless, true);
      assertEquals(props?.bitsPerSample, 16);
    } finally {
      file.save();
      file.dispose();
    }
  });

  it("WAV container - uncompressed PCM codec", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const wavPath = join("tests", "test-files", "wav", "kiss-snippet.wav");
    const wavBuffer = await Deno.readFile(wavPath);
    const file = await taglib.open(wavBuffer);

    try {
      const props = file.audioProperties();
      assertEquals(props?.containerFormat, "WAV");
      assertEquals(props?.codec, "PCM");
      assertEquals(props?.isLossless, true);
      assertEquals(props?.bitsPerSample, 16);
    } finally {
      file.save();
      file.dispose();
    }
  });

  it("OGG container - Vorbis codec", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const oggPath = join("tests", "test-files", "ogg", "kiss-snippet.ogg");
    const oggBuffer = await Deno.readFile(oggPath);
    const file = await taglib.open(oggBuffer);

    try {
      const props = file.audioProperties();
      assertEquals(props?.containerFormat, "OGG");
      assertEquals(props?.codec, "Vorbis");
      assertEquals(props?.isLossless, false);
      assertEquals(props?.bitsPerSample, 0);
    } finally {
      file.save();
      file.dispose();
    }
  });

  it("MP4 container (M4A file) - AAC codec", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const m4aPath = join("tests", "test-files", "mp4", "kiss-snippet.m4a");
    const m4aBuffer = await Deno.readFile(m4aPath);
    const file = await taglib.open(m4aBuffer);

    try {
      const props = file.audioProperties();
      assertEquals(props?.containerFormat, "MP4");
      assertEquals(props?.codec, "AAC");
      assertEquals(props?.isLossless, false);
      console.log(`M4A bits per sample: ${props?.bitsPerSample}`);
    } finally {
      file.save();
      file.dispose();
    }
  });

  /**
   * Regression test for FLAC files whose audio frame sync code (0xFFF8)
   * matches the MPEG sync pattern (0xFF 0xEx), which previously caused
   * TagLib's content-based detection to misidentify the file as MP3.
   *
   * The file "flac-with-mpeg-sync.flac" is the exact file from the issue
   * report (mp3-flac.zip). It is a valid FLAC file but has audio frames
   * starting with 0xFFF8, which TagLib's MPEG::File::isSupported() picks up
   * before FLAC::File::isSupported() is checked.
   */
  it("FLAC with MPEG-like frame sync - must NOT be detected as MP3", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const flacPath = join(
      "tests",
      "test-files",
      "flac",
      "flac-with-mpeg-sync.flac",
    );
    const flacBuffer = await Deno.readFile(flacPath);
    const file = await taglib.open(flacBuffer);

    try {
      const format = file.getFormat();
      const props = file.audioProperties();
      assertEquals(
        format,
        "FLAC",
        `Expected format "FLAC" but got "${format}" — FLAC file was misdetected as MP3`,
      );
      assertEquals(
        props?.containerFormat,
        "FLAC",
        `Expected containerFormat "FLAC" but got "${props?.containerFormat}"`,
      );
      assertEquals(props?.codec, "FLAC");
      assertEquals(props?.isLossless, true);
      assertEquals(props?.sampleRate, 44100);
      assertEquals(props?.channels, 2);
    } finally {
      file.dispose();
    }
  });

  /**
   * Regression test for FLAC files that have an ID3v2 tag prepended.
   * These files start with "ID3" bytes, which TagLib's content-detection
   * previously misidentified as MP3 when using buffer-based detection.
   */
  it("FLAC with ID3 header - must NOT be detected as MP3", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const flacPath = join(
      "tests",
      "test-files",
      "flac",
      "kiss-snippet-with-id3.flac",
    );
    const flacBuffer = await Deno.readFile(flacPath);
    const file = await taglib.open(flacBuffer);

    try {
      const format = file.getFormat();
      const props = file.audioProperties();
      assertEquals(
        format,
        "FLAC",
        `Expected format "FLAC" but got "${format}" — FLAC+ID3 file was misdetected as MP3`,
      );
      assertEquals(
        props?.containerFormat,
        "FLAC",
        `Expected containerFormat "FLAC" but got "${props?.containerFormat}"`,
      );
      assertEquals(props?.codec, "FLAC");
      assertEquals(props?.isLossless, true);
    } finally {
      file.dispose();
    }
  });
});

/**
 * Cross-backend format detection tests for the FLAC misdetection regression.
 * Runs against every available backend (WASI + Emscripten).
 */
forEachBackend(
  "FLAC misdetection regression",
  (adapter: BackendAdapter) => {
    beforeAll(async () => {
      await adapter.init();
    });

    afterAll(async () => {
      await adapter.dispose();
    });

    it(
      "FLAC with MPEG-like frame sync detected as FLAC, not MP3",
      async () => {
        const buffer = await Deno.readFile(
          join("tests", "test-files", "flac", "flac-with-mpeg-sync.flac"),
        );
        const format = await adapter.readFormat(buffer, "flac");
        assertEquals(
          format,
          "FLAC",
          `[${adapter.kind}] FLAC file with MPEG-like sync was misdetected as "${format}"`,
        );
      },
    );

    it(
      "FLAC with ID3 header detected as FLAC, not MP3",
      async () => {
        const buffer = await Deno.readFile(
          join("tests", "test-files", "flac", "kiss-snippet-with-id3.flac"),
        );
        const format = await adapter.readFormat(buffer, "flac");
        assertEquals(
          format,
          "FLAC",
          `[${adapter.kind}] FLAC+ID3 file was misdetected as "${format}"`,
        );
      },
    );
  },
);
