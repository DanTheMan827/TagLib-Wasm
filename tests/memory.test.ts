/**
 * @fileoverview Memory management tests for TagLib-Wasm
 */

import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { TagLib } from "../index.ts";
import { TEST_FILES } from "./test-utils.ts";

const TEST_FILE = TEST_FILES.mp3;

describe("Memory Management", () => {
  it("dispose() prevents memory accumulation", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });

    const getHeapSize = () => {
      if ((taglib as any).module && (taglib as any).module.HEAP8) {
        return (taglib as any).module.HEAP8.byteLength;
      }
      return 0;
    };

    const initialHeap = getHeapSize();

    for (let i = 0; i < 10; i++) {
      const audioFile = await taglib.open(TEST_FILE);
      const tag = audioFile.tag();

      const _ = tag.title;
      const __ = tag.artist;
      const ___ = tag.album;

      audioFile.dispose();
    }

    const finalHeap = getHeapSize();

    if (initialHeap > 0 && finalHeap > 0) {
      const growth = finalHeap - initialHeap;
      const growthMB = growth / 1024 / 1024;
      console.log(
        `Heap growth after 10 open/dispose cycles: ${growthMB.toFixed(2)}MB`,
      );

      assertEquals(
        growthMB < 1,
        true,
        `Excessive heap growth: ${growthMB.toFixed(2)}MB`,
      );
    }
  });

  it("dispose() can be called multiple times safely", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });
    const audioFile = await taglib.open(TEST_FILE);

    audioFile.dispose();

    audioFile.dispose();

    audioFile.dispose();

    try {
      audioFile.tag();
    } catch (e) {
      console.log(
        "Expected error after dispose:",
        e instanceof Error ? e.message : String(e),
      );
    }
  });

  it("memory usage scales with file size", async () => {
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });

    const files = [
      TEST_FILES.wav, // Larger
      TEST_FILES.mp3, // Smaller
    ];

    const getHeapSize = () => {
      if ((taglib as any).module && (taglib as any).module.HEAP8) {
        return (taglib as any).module.HEAP8.byteLength;
      }
      return 0;
    };

    for (const file of files) {
      const beforeOpen = getHeapSize();

      const audioFile = await taglib.open(file);
      const afterOpen = getHeapSize();

      const fileInfo = await Deno.stat(file);
      const fileSizeMB = fileInfo.size / 1024 / 1024;

      audioFile.dispose();
      const afterDispose = getHeapSize();

      if (beforeOpen > 0) {
        const loadIncrease = (afterOpen - beforeOpen) / 1024 / 1024;
        const disposeDecrease = (afterOpen - afterDispose) / 1024 / 1024;

        console.log(`File: ${file} (${fileSizeMB.toFixed(2)}MB)`);
        console.log(`  Load increase: ${loadIncrease.toFixed(2)}MB`);
        console.log(`  Dispose freed: ${disposeDecrease.toFixed(2)}MB`);
      }
    }
  });

  it("setPictures heap growth is bounded to ≤2× image size (single-copy fix)", async () => {
    // Regression test for the uint8ArrayToByteVector double-allocation bug.
    //
    // Root cause: the old implementation called convertJSArrayToNumberVector<uint8_t>
    // (allocates a std::vector<uint8_t> = 1× image on WASM heap) and then
    // constructed a TagLib::ByteVector by copying from it (another 1× image).
    // Because the WASM heap only grows (ALLOW_MEMORY_GROWTH=1), both allocations
    // are reflected in the peak heap size even after the std::vector is freed.
    // This produced ~4× peak heap usage when saving a file with large cover art.
    //
    // Fix: pre-allocate the ByteVector at the target size and copy directly into
    // it via typed_memory_view.set() — the same single-copy pattern used by
    // loadFromBuffer.  This cuts the setPictures allocation to 1× image size,
    // bringing the overall save peak from ~4× down to ~3× the output file size.
    const taglib = await TagLib.initialize({ forceWasmType: "emscripten" });

    const getHeapSize = (): number => {
      const m = (taglib as any).module;
      return (m?.HEAP8?.byteLength ?? 0) as number;
    };

    // Build a synthetic cover-art image large enough to exercise the allocator.
    // 128 KiB is sufficient to trigger measurable WASM heap growth without
    // making the test slow.
    const IMAGE_SIZE = 128 * 1024; // 128 KiB
    const syntheticImage = new Uint8Array(IMAGE_SIZE);
    // Write a valid PNG magic number so TagLib accepts it as an image.
    syntheticImage.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const audioFile = await taglib.open(TEST_FILES.mp3);

    const beforeSet = getHeapSize();

    audioFile.setPictures([{
      mimeType: "image/png",
      type: "FrontCover",
      description: "",
      data: syntheticImage,
    }]);

    const afterSet = getHeapSize();

    // Verify the picture was actually stored.
    const pictures = audioFile.getPictures();
    assertEquals(pictures.length, 1, "One picture should be stored");

    audioFile.dispose();

    // If the heap measurement is available, assert that the growth during
    // setPictures did not exceed 2× the image size.  With the old double-copy
    // code the heap would grow by ≥2× IMAGE_SIZE; with the fix it grows by
    // ≤1× IMAGE_SIZE plus small allocator overhead.
    if (beforeSet > 0 && afterSet > 0) {
      const heapGrowth = afterSet - beforeSet;
      console.log(
        `setPictures heap growth for ${IMAGE_SIZE / 1024}KiB image: ` +
          `${(heapGrowth / 1024).toFixed(1)}KiB ` +
          `(ratio: ${(heapGrowth / IMAGE_SIZE).toFixed(2)}×)`,
      );

      // With the single-copy fix the growth should be well below 2× the image
      // size.  We allow 2.0× as a generous threshold to accommodate allocator
      // padding and any other small overhead, while still catching the pre-fix
      // regression (which would show ≥2× growth).
      assert(
        heapGrowth < IMAGE_SIZE * 2,
        `WASM heap grew by ${(heapGrowth / 1024).toFixed(1)}KiB for a ` +
          `${IMAGE_SIZE / 1024}KiB image — expected < ${
            (IMAGE_SIZE * 2 / 1024).toFixed(0)
          }KiB (2× image size). ` +
          `This suggests the double-allocation regression has returned.`,
      );
    }
  });
});
