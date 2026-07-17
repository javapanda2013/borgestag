/*
 * omggif.js — GIF89a encoder (GifWriter only), ES module vendoring for BorgesTag.
 *
 * Derived from omggif by Dean McNamee <dean@gmail.com> (MIT License).
 *   https://github.com/deanm/omggif
 *
 * The MIT License (MIT)
 * Copyright (c) 2013 Dean McNamee
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * BorgesTag notes (GROUP-150 v1.48.0):
 * - Only the writer (encoder) is vendored; the reader is not needed (gifuct handles decode).
 * - Cleaned up to a standalone ES module. No eval / new Function (CSP: script-src 'self').
 * - Supports per-frame local palette, per-frame delay (centiseconds), disposal and transparency.
 * - `buf` is any array-like that supports index assignment and `.length` growth (Array or a
 *   growable Uint8Array wrapper). We use a plain Array for simplicity, matching upstream.
 */

// GifWriter(buf, width, height, gopts?)
//   buf    : output byte array (indexable, e.g. []).
//   width  : logical screen width.
//   height : logical screen height.
//   gopts  : { loop?: number (0 = infinite), palette?: number[] (global color table) }
export function GifWriter(buf, width, height, gopts) {
  let p = 0; // write cursor
  gopts = gopts === undefined ? {} : gopts;
  const loop_count = gopts.loop === undefined ? null : gopts.loop;
  const global_palette = gopts.palette === undefined ? null : gopts.palette;

  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) {
    throw new Error("Width/Height invalid.");
  }

  function check_palette_and_num_colors(palette) {
    const num_colors = palette.length;
    if (num_colors < 2 || num_colors > 256 || (num_colors & (num_colors - 1))) {
      throw new Error(
        "Invalid code/color length, must be power of 2 and 2 .. 256."
      );
    }
    return num_colors;
  }

  // Header ("GIF89a").
  buf[p++] = 0x47; buf[p++] = 0x49; buf[p++] = 0x46;
  buf[p++] = 0x38; buf[p++] = 0x39; buf[p++] = 0x61;

  // Logical Screen Descriptor.
  const wmsb = (width >> 8) & 0xff, hmsb = (height >> 8) & 0xff;
  buf[p++] = width & 0xff; buf[p++] = wmsb;
  buf[p++] = height & 0xff; buf[p++] = hmsb;

  // Global Color Table (packed field). We prefer local color tables per frame,
  // but support a global one for completeness.
  let gp_num_colors_pow2 = 0;
  let background = 0;
  if (global_palette !== null) {
    let gp_num_colors = check_palette_and_num_colors(global_palette);
    while (gp_num_colors >>= 1) ++gp_num_colors_pow2;
    gp_num_colors = 1 << gp_num_colors_pow2;
    --gp_num_colors_pow2;
    buf[p++] = 0x80 | gp_num_colors_pow2; // global color table flag + size.
    buf[p++] = background; // background color index.
    buf[p++] = 0; // pixel aspect ratio (unused).
    for (let i = 0, il = global_palette.length; i < il; ++i) {
      const rgb = global_palette[i];
      buf[p++] = (rgb >> 16) & 0xff;
      buf[p++] = (rgb >> 8) & 0xff;
      buf[p++] = rgb & 0xff;
    }
  } else {
    buf[p++] = 0; // no global color table.
    buf[p++] = 0; // background.
    buf[p++] = 0; // aspect ratio.
  }

  // NETSCAPE2.0 Application Extension for looping.
  if (loop_count !== null) {
    if (loop_count < 0 || loop_count > 65535) {
      throw new Error("Loop count invalid.");
    }
    buf[p++] = 0x21; buf[p++] = 0xff; buf[p++] = 0x0b;
    buf[p++] = 0x4e; buf[p++] = 0x45; buf[p++] = 0x54; buf[p++] = 0x53; // NETS
    buf[p++] = 0x43; buf[p++] = 0x41; buf[p++] = 0x50; buf[p++] = 0x45; // CAPE
    buf[p++] = 0x32; buf[p++] = 0x2e; buf[p++] = 0x30; // 2.0
    buf[p++] = 0x03; buf[p++] = 0x01;
    buf[p++] = loop_count & 0xff; buf[p++] = (loop_count >> 8) & 0xff;
    buf[p++] = 0x00;
  }

  let ended = false;

  // addFrame(x, y, w, h, indexed_pixels, opts?)
  //   indexed_pixels : per-pixel palette indices (length must be w*h).
  //   opts : { palette?: number[] local color table (0xRRGGBB),
  //            delay?: centiseconds,
  //            disposal?: 0..3,
  //            transparent?: palette index }
  this.addFrame = function (x, y, w, h, indexed_pixels, opts) {
    if (ended === true) { --p; ended = false; } // Un-end.
    opts = opts === undefined ? {} : opts;

    if (x < 0 || y < 0 || x > 65535 || y > 65535) {
      throw new Error("x/y invalid.");
    }
    if (w <= 0 || h <= 0 || w > 65535 || h > 65535) {
      throw new Error("Width/Height invalid.");
    }
    if (indexed_pixels.length < w * h) {
      throw new Error("Not enough pixels for the frame size.");
    }

    let using_local_palette = true;
    let palette = opts.palette;
    if (palette === undefined || palette === null) {
      using_local_palette = false;
      palette = global_palette;
    }
    if (palette === undefined || palette === null) {
      throw new Error("Must supply either a local or global palette.");
    }

    let num_colors = check_palette_and_num_colors(palette);
    let min_code_size = 0;
    while (num_colors >>= 1) ++min_code_size;
    num_colors = 1 << min_code_size; // Now we can easily get it back.

    const delay = opts.delay === undefined ? 0 : opts.delay;
    const disposal = opts.disposal === undefined ? 0 : opts.disposal;
    if (disposal < 0 || disposal > 3) throw new Error("Disposal out of range.");

    let use_transparency = false;
    let transparent_index = 0;
    if (opts.transparent !== undefined && opts.transparent !== null) {
      use_transparency = true;
      transparent_index = opts.transparent;
      if (transparent_index < 0 || transparent_index >= num_colors) {
        throw new Error("Transparent color index.");
      }
    }

    if (disposal !== 0 || use_transparency || delay !== 0) {
      // Graphic Control Extension.
      buf[p++] = 0x21; buf[p++] = 0xf9; buf[p++] = 0x04;
      buf[p++] = (disposal << 2) | (use_transparency === true ? 1 : 0);
      buf[p++] = delay & 0xff; buf[p++] = (delay >> 8) & 0xff;
      buf[p++] = transparent_index;
      buf[p++] = 0;
    }

    // Image Descriptor.
    buf[p++] = 0x2c;
    buf[p++] = x & 0xff; buf[p++] = (x >> 8) & 0xff;
    buf[p++] = y & 0xff; buf[p++] = (y >> 8) & 0xff;
    buf[p++] = w & 0xff; buf[p++] = (w >> 8) & 0xff;
    buf[p++] = h & 0xff; buf[p++] = (h >> 8) & 0xff;
    // Local color table flag (0x80) if we have a local palette.
    buf[p++] = using_local_palette === true ? (0x80 | (min_code_size - 1)) : 0;

    if (using_local_palette === true) {
      for (let i = 0, il = palette.length; i < il; ++i) {
        const rgb = palette[i];
        buf[p++] = (rgb >> 16) & 0xff;
        buf[p++] = (rgb >> 8) & 0xff;
        buf[p++] = rgb & 0xff;
      }
    }

    p = GifWriterOutputLZWCodeStream(
      buf, p, min_code_size < 2 ? 2 : min_code_size, indexed_pixels
    );
  };

  this.end = function () {
    if (ended === false) { buf[p++] = 0x3b; ended = true; }
    return p;
  };

  this.getOutputBuffer = function () { return buf; };
  this.setOutputBufferPosition = function (v) { p = v; };
  this.getOutputBufferPosition = function () { return p; };
}

// LZW encode `index_stream` into GIF sub-blocks, appending to `buf` at `p`.
// Returns the new write position. This mirrors upstream omggif exactly.
function GifWriterOutputLZWCodeStream(buf, p, min_code_size, index_stream) {
  buf[p++] = min_code_size;
  let cur_subblock = p++; // Pending 256-byte sub-block length byte position.

  const clear_code = 1 << min_code_size;
  const code_mask = clear_code - 1;
  const eoi_code = clear_code + 1;
  let next_code = eoi_code + 1;

  let cur_code_size = min_code_size + 1; // Number of bits per code.
  let cur_shift = 0;
  // We have at most 12-bit codes, so we should have to hold a max of 19
  // bits here (and then we would flush).
  let cur = 0;

  function emit_bytes_to_buffer(bit_block_size) {
    while (cur_shift >= bit_block_size) {
      buf[p++] = cur & 0xff;
      cur >>= 8; cur_shift -= 8;
      if (p === cur_subblock + 256) { // Finished a subblock.
        buf[cur_subblock] = 255;
        cur_subblock = p++;
      }
    }
  }

  function emit_code(c) {
    cur |= c << cur_shift;
    cur_shift += cur_code_size;
    emit_bytes_to_buffer(8);
  }

  // I am not an expert on the topic, and I don't want to write a thesis.
  // However, it is good to outline here the basic algorithm and the few data
  // structures and optimizations here that make this implementation fast.
  let ib_code = index_stream[0] & code_mask; // Load first input index.
  let code_table = {}; // Key'd on our 20-bit "tuple".

  emit_code(clear_code); // Spec says first code should be a clear code.

  for (let i = 1, il = index_stream.length; i < il; ++i) {
    const k = index_stream[i] & code_mask;
    const cur_key = (ib_code << 8) | k; // (prev, k) unique tuple.
    const cur_code = code_table[cur_key]; // buffer + k.

    // Check if we have to create a new code table entry.
    if (cur_code === undefined) { // We don't have buffer + k.
      // Emit index buffer (without k).
      // This is an inline version of emit_code, because this is the core
      // writing routine of the compressor (and V8 cannot inline emit_code
      // because it is a closure here in a different context).  Additionally
      // we can call emit_byte_to_buffer less often, because we can have 30
      // bits (from our 31 bit signed SMI), and we know our codes will be 12
      // bits max, so we can safely have 18 bits there without overflow.
      // emit_code(ib_code);
      cur |= ib_code << cur_shift;
      cur_shift += cur_code_size;
      while (cur_shift >= 8) {
        buf[p++] = cur & 0xff;
        cur >>= 8; cur_shift -= 8;
        if (p === cur_subblock + 256) { // Finished a subblock.
          buf[cur_subblock] = 255;
          cur_subblock = p++;
        }
      }

      if (next_code === 4096) { // Table full, need a clear.
        emit_code(clear_code);
        next_code = eoi_code + 1;
        cur_code_size = min_code_size + 1;
        code_table = {};
      } else { // Table not full, insert a new entry.
        // Increase our variable bit code sizes if necessary.  This is a bit
        // tricky as it is based on "timing" between the encoding and
        // decoder.  From the encoders perspective this should happen after
        // we've already emitted the index buffer and are about to create the
        // first table entry that would overflow our current code bit size.
        if (next_code >= (1 << cur_code_size)) ++cur_code_size;
        code_table[cur_key] = next_code++; // Insert into code table.
      }

      ib_code = k; // Index buffer to single input k.
    } else {
      ib_code = cur_code; // Index buffer to sequence in code table.
    }
  }

  emit_code(ib_code); // There will still be something in the index buffer.
  emit_code(eoi_code); // End Of Information.

  // Flush / finish the sub-blocks stream to the buffer.
  emit_bytes_to_buffer(1);

  // Finish the sub-block, in case it isn't already done.
  if (p === cur_subblock + 1) { // Started but empty.
    buf[cur_subblock] = 0;
  } else { // Started and non-empty, with the completed block-length byte.
    buf[cur_subblock] = p - cur_subblock - 1;
    buf[p++] = 0; // Empty sub-block to end the stream.
  }
  return p;
}
