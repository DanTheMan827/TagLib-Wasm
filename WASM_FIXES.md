# WASM Memory Leak & JS/WASM Boundary Performance Fixes

## Overview

This document summarizes the bugs found, explains why they cause 200 MB files
to fail, and shows the exact code changes that fix them.  
All fixes live in **`build/taglib_embind.cpp`**, the C++ source that is compiled
into **`build/taglib-web.wasm`** (the Emscripten backend used by browsers and
environments that cannot use the WASI backend).

> **The pre-compiled `.wasm` binary in this repository is built from the
> `.cpp` source by CI.**  The source has already been patched with all fixes
> described below.  The binary will be regenerated automatically the next time
> `build/build-wasm.sh` is run with Emscripten installed (≥ 3.x, emsdk).

---

## Root Causes

### 1 — `loadFromBuffer`: byte-by-byte copy × 200,000,000 iterations

**Location:** `FileHandle::loadFromBuffer()` (~line 332)

The original code copied each byte from JavaScript to C++ individually:

```cpp
// BEFORE – O(N) × JS↔WASM round trips
std::vector<char> data(length);
for (unsigned int i = 0; i < length; i++) {
    data[i] = jsBuffer[i].as<unsigned char>();   // one JS→C++ call per byte
}
```

For a 200 MB file that is **200,000,000 separate JavaScript-to-WASM context
switches**.  Emscripten's embind machinery must resolve each element access
through the JavaScript engine.  This causes the call to hang or OOM before it
even finishes loading.

**Fix (applied):**

```cpp
// AFTER – one native bulk copy via HEAPU8.set()
uint8_t* heapData = static_cast<uint8_t*>(malloc(length));
uintptr_t heapPtr = reinterpret_cast<uintptr_t>(heapData);
val::module_property("HEAPU8").call<void>("set", jsBuffer, heapPtr);
// TagLib::ByteVector makes its own internal copy
TagLib::ByteVector buffer(reinterpret_cast<const char*>(heapData), length);
free(heapData);   // release the temporary region immediately
```

`HEAPU8.set(src, byteOffset)` is a single native TypedArray operation – it
copies the entire buffer in **one call** using the browser/runtime's optimised
memory copy path (usually `memcpy` under the hood).

---

### 2 — `detectFormat`: copying the full 200 MB file into a `std::string`

**Location:** `FileHandle::loadFromBuffer()`, fallback branch (~line 362)

When `FileRef` failed to identify the format, the original code created a
complete `std::string` copy of the entire file just to inspect 12 magic bytes:

```cpp
// BEFORE – copies the entire file into a temporary std::string (200 MB!)
std::string format = detectFormat(std::string(data.data(), data.size()));
```

Combined with the first copy in `std::vector<char> data` and the copy inside
`TagLib::ByteVector`, this meant **three** complete copies of the file lived in
the WASM heap simultaneously during `loadFromBuffer` — 600 MB for a 200 MB
file.

**Fix (applied):** The `detectFormat` helper now accepts `const char*, size_t`
and only the first 12 header bytes are passed:

```cpp
// AFTER – capture 12 bytes before freeing the heap buffer
char header[12] = {};
unsigned int headerLen = length < 12u ? length : 12u;
memcpy(header, heapData, headerLen);
// …
std::string format = detectFormat(header, headerLen);   // tiny stack allocation
```

The helper signature was changed from `std::string` to `const char*, size_t`:

```cpp
// BEFORE
std::string detectFormat(const std::string& data) const { … }

// AFTER
std::string detectFormat(const char* d, size_t len) const { … }
```

---

### 3 — `getBuffer`: byte-by-byte copy back to JavaScript

**Location:** `FileHandle::getBuffer()` (~line 608)

After saving, the modified file is returned to JavaScript element by element:

```cpp
// BEFORE – O(N) × JS↔WASM round trips back across the boundary
val uint8Array = val::global("Uint8Array").new_(data->size());
for (size_t i = 0; i < data->size(); i++) {
    uint8Array.set(i, static_cast<unsigned char>((*data)[i]));
}
```

For a 200 MB file this is another 200,000,000 individual element writes.  In
practice the JavaScript engine stalls and the call never returns.

**Fix (applied):** TagLib's `ByteVector` data already lives in the WASM heap.
We take its raw address, create a zero-copy `HEAPU8.subarray()` view, then
hand that view to the `Uint8Array` constructor which performs a single native
bulk copy:

```cpp
// AFTER – two O(1) calls + one native memcpy
uintptr_t ptr = reinterpret_cast<uintptr_t>(data->data());
val heapu8 = val::module_property("HEAPU8");
val view = heapu8.call<val>("subarray", ptr, ptr + sz);   // zero-copy view
return val::global("Uint8Array").new_(view);              // one native copy
```

---

### 4 — `getPictures` / `setPictures` / `addPicture`: byte-by-byte picture data

**Location:** All three methods, repeated for MP3, MP4, FLAC, and Ogg branches.

Cover art images stored in tags are typically 100 KB – 10 MB.  The original
code iterated byte-by-byte in the same pattern as issues 1 and 3.

**Fix (applied):** Two private static helpers were added:

```cpp
// C++ → JS  (used in getPictures)
static val byteVectorToUint8Array(const TagLib::ByteVector& bv) {
    if (bv.isEmpty()) return val::global("Uint8Array").new_(0);
    uintptr_t ptr = reinterpret_cast<uintptr_t>(bv.data());
    val heapu8 = val::module_property("HEAPU8");
    val view = heapu8.call<val>("subarray", ptr, ptr + bv.size());
    return val::global("Uint8Array").new_(view);
}

// JS → C++  (used in setPictures / addPicture)
static TagLib::ByteVector uint8ArrayToByteVector(const val& jsArray) {
    unsigned int length = jsArray["byteLength"].isUndefined()
        ? jsArray["length"].as<unsigned int>()
        : jsArray["byteLength"].as<unsigned int>();
    if (length == 0) return TagLib::ByteVector();
    uint8_t* buf = static_cast<uint8_t*>(malloc(length));
    if (!buf) return TagLib::ByteVector();
    uintptr_t ptr = reinterpret_cast<uintptr_t>(buf);
    val::module_property("HEAPU8").call<void>("set", jsArray, ptr);
    TagLib::ByteVector bv(reinterpret_cast<const char*>(buf), length);
    free(buf);
    return bv;
}
```

Every `for (int j = 0; j < dataLength; j++) { buffer[j] = data[j]…; }` loop
in the picture handling code was replaced with a call to one of these helpers.

---

## Memory Model After Fixes

| Phase | Peak extra WASM heap (200 MB file) |
|---|---|
| **Before** `loadFromBuffer` | `std::vector` copy (200 MB) + `ByteVector` copy (200 MB) + `std::string` for format (200 MB) = **600 MB extra** |
| **After** `loadFromBuffer` | `malloc` temp (200 MB, freed immediately) + `ByteVector` copy (200 MB) = **200 MB extra at peak** |
| `getBuffer` before | Extra Uint8Array (200 MB in WASM + 200 MB in JS) = **400 MB extra** |
| `getBuffer` after | HEAPU8 view (zero-copy) + JS copy = **200 MB extra** |

A 200 MB file now needs roughly **400 MB** of WASM heap headroom instead of
**1 GB**, fitting well within the `MAXIMUM_MEMORY=1GB` limit in
`build/build-wasm.sh`.

---

## How to Rebuild the WASM Binary

These changes are already in `build/taglib_embind.cpp`.  To produce a new
`build/taglib-web.wasm` + `build/taglib-wrapper.js`:

```bash
# 1. Install Emscripten (one-time)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install 3.1.74 && ./emsdk activate 3.1.74
source ./emsdk_env.sh
cd ..

# 2. Clone with TagLib submodule
git submodule update --init --recursive

# 3. Build
./build/build-wasm.sh
```

CI (`build/build-wasm.sh` / `.github/workflows/dual-build.yml`) does this
automatically on every push to `main`.

---

## Fixes That Require No Recompilation

The WASI backend (`src/runtime/wasi-adapter/wasm-io.ts`) already uses
`WasmArena` for all JS/WASM buffer transfers and is **not affected** by any of
the issues above.  No changes were needed to the WASI path.

---

## Summary Table

| # | File | Function | Bug | Fix | Requires recompile? |
|---|---|---|---|---|---|
| 1 | `taglib_embind.cpp` | `loadFromBuffer` | 200M byte-by-byte JS→C++ copies | `HEAPU8.set()` bulk copy | ✅ yes |
| 2 | `taglib_embind.cpp` | `loadFromBuffer` / `detectFormat` | Full 200 MB file copied into `std::string` for 12-byte format detection | Pass only 12-byte header | ✅ yes |
| 3 | `taglib_embind.cpp` | `getBuffer` | 200M byte-by-byte C++→JS copies | `HEAPU8.subarray()` + `new Uint8Array` | ✅ yes |
| 4 | `taglib_embind.cpp` | `getPictures`, `setPictures`, `addPicture` | Byte-by-byte picture data copies | `byteVectorToUint8Array` / `uint8ArrayToByteVector` helpers | ✅ yes |
