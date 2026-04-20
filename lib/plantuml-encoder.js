/**
 * PlantUML URL encoder.
 * Compresses source with raw DEFLATE, then encodes each 3 bytes as 4 chars
 * using PlantUML's custom 64-char alphabet (0-9 A-Z a-z - _).
 * Exposes `window.plantumlEncoder.encode(source) -> Promise<string>`.
 */
(function () {
  "use strict";

  function encode6bit(b) {
    if (b < 10) return String.fromCharCode(48 + b);
    b -= 10;
    if (b < 26) return String.fromCharCode(65 + b);
    b -= 26;
    if (b < 26) return String.fromCharCode(97 + b);
    b -= 26;
    if (b === 0) return "-";
    if (b === 1) return "_";
    return "?";
  }

  function append3bytes(out, b1, b2, b3) {
    const c1 = (b1 >> 2) & 0x3F;
    const c2 = (((b1 & 0x3) << 4) | (b2 >> 4)) & 0x3F;
    const c3 = (((b2 & 0xF) << 2) | (b3 >> 6)) & 0x3F;
    const c4 = b3 & 0x3F;
    out.push(encode6bit(c1), encode6bit(c2), encode6bit(c3), encode6bit(c4));
  }

  async function deflateRaw(bytes) {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function encode(source) {
    const bytes = new TextEncoder().encode(source);
    const compressed = await deflateRaw(bytes);
    const out = [];
    for (let i = 0; i < compressed.length; i += 3) {
      append3bytes(
        out,
        compressed[i],
        i + 1 < compressed.length ? compressed[i + 1] : 0,
        i + 2 < compressed.length ? compressed[i + 2] : 0
      );
    }
    return out.join("");
  }

  window.plantumlEncoder = { encode };
})();
