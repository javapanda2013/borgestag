/*
 * neuquant.js — NeuQuant Neural-Net image quantization, ES module vendoring for BorgesTag.
 *
 * NeuQuant Neural-Net Quantization Algorithm
 * Copyright (c) 1994 Anthony Dekker
 * JavaScript port 2012 by Johan Nordberg.
 * (Used by gif.js as TypedNeuQuant.js.)
 *
 * See "Kohonen neural networks for optimal colour quantization" in "Network:
 * Computation in Neural Systems" Vol. 5 (1994) pp 351-367.
 *
 * Any party obtaining a copy of these files from the author, directly or
 * indirectly, is granted, free of charge, a full and unrestricted irrevocable,
 * world-wide, paid up, royalty-free, nonexclusive right and license to deal in
 * this software and documentation files (the "Software"), including without
 * limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons who
 * receive copies from any such party to do so, with the only requirement being
 * that this copyright notice remain intact.
 *
 * BorgesTag notes (GROUP-150 v1.48.0):
 * - Standalone ES module. No eval / new Function (CSP: script-src 'self').
 * - Input `pixels` is an RGB byte array (3 bytes/pixel). Strip alpha before calling.
 */

const ncycles = 100; // number of learning cycles
const netsize = 256; // number of colors used
const maxnetpos = netsize - 1;

// defs for freq and bias
const netbiasshift = 4; // bias for colour values
const intbiasshift = 16; // bias for fractions
const intbias = 1 << intbiasshift;
const gammashift = 10;
const betashift = 10;
const beta = intbias >> betashift; /* beta = 1/1024 */
const betagamma = intbias << (gammashift - betashift);

// defs for decreasing radius factor
const initrad = netsize >> 3; // for 256 cols, radius starts at 32.0
const radiusbiasshift = 6; // at 32.0 biased by 6 bits
const radiusbias = 1 << radiusbiasshift;
const initradius = initrad * radiusbias; // and decreases by a factor of
const radiusdec = 30; // 1/30 each cycle

// defs for decreasing alpha factor
const alphabiasshift = 10; // alpha starts at 1.0
const initalpha = 1 << alphabiasshift;

/* radbias and alpharadbias used for radpower calculation */
const radbiasshift = 8;
const radbias = 1 << radbiasshift;
const alpharadbshift = alphabiasshift + radbiasshift;
const alpharadbias = 1 << alpharadbshift;

// four primes near 500 - assume no image has a length so large that it is
// divisible by all four primes
const prime1 = 499;
const prime2 = 491;
const prime3 = 487;
const prime4 = 503;
const minpicturebytes = 3 * prime4;

/*
 * Constructor: NeuQuant(pixels, samplefac)
 *   pixels    : Uint8Array of RGB (3 bytes per pixel).
 *   samplefac : sampling factor 1..30 (1 = best quality/slowest, 30 = fastest).
 */
export function NeuQuant(pixels, samplefac) {
  let network; // int[netsize][4]
  let netindex; // for network lookup - really 256

  // bias and freq arrays for learning
  let bias;
  let freq;
  let radpower;

  /*
   * Initialise network in range (0,0,0) to (255,255,255) and set parameters
   */
  function init() {
    network = [];
    netindex = new Int32Array(256);
    bias = new Int32Array(netsize);
    freq = new Int32Array(netsize);
    radpower = new Int32Array(netsize >> 3);

    let i, v;
    for (i = 0; i < netsize; i++) {
      v = (i << (netbiasshift + 8)) / netsize;
      network[i] = new Float64Array([v, v, v, 0]);
      freq[i] = intbias / netsize;
      bias[i] = 0;
    }
  }

  /*
   * Unbias network to give byte values 0..255 and record position i to prepare
   * for sort
   */
  function unbiasnet() {
    for (let i = 0; i < netsize; i++) {
      network[i][0] >>= netbiasshift;
      network[i][1] >>= netbiasshift;
      network[i][2] >>= netbiasshift;
      network[i][3] = i; // record color number
    }
  }

  /*
   * Move i neuron towards biased (b,g,r) by factor alpha
   */
  function altersingle(alpha, i, b, g, r) {
    network[i][0] -= (alpha * (network[i][0] - b)) / initalpha;
    network[i][1] -= (alpha * (network[i][1] - g)) / initalpha;
    network[i][2] -= (alpha * (network[i][2] - r)) / initalpha;
  }

  /*
   * Move adjacent neurons by precomputed alpha*(1-((i-j)^2/[r]^2)) in radpower[|i-j|]
   */
  function alterneigh(radius, i, b, g, r) {
    const lo = Math.abs(i - radius);
    const hi = Math.min(i + radius, netsize);

    let j = i + 1;
    let k = i - 1;
    let m = 1;

    let p, a;
    while (j < hi || k > lo) {
      a = radpower[m++];

      if (j < hi) {
        p = network[j++];
        p[0] -= (a * (p[0] - b)) / alpharadbias;
        p[1] -= (a * (p[1] - g)) / alpharadbias;
        p[2] -= (a * (p[2] - r)) / alpharadbias;
      }

      if (k > lo) {
        p = network[k--];
        p[0] -= (a * (p[0] - b)) / alpharadbias;
        p[1] -= (a * (p[1] - g)) / alpharadbias;
        p[2] -= (a * (p[2] - r)) / alpharadbias;
      }
    }
  }

  /*
   * Search for biased BGR values
   */
  function contest(b, g, r) {
    /*
      finds closest neuron (min dist) and updates freq
      finds best neuron (min dist-bias) and returns position
      for frequently chosen neurons, freq[i] is high and bias[i] is negative
      bias[i] = gamma * ((1 / netsize) - freq[i])
    */

    let bestd = ~(1 << 31);
    let bestbiasd = bestd;
    let bestpos = -1;
    let bestbiaspos = bestpos;

    let i, n, dist, biasdist, betafreq;
    for (i = 0; i < netsize; i++) {
      n = network[i];

      dist = Math.abs(n[0] - b) + Math.abs(n[1] - g) + Math.abs(n[2] - r);
      if (dist < bestd) {
        bestd = dist;
        bestpos = i;
      }

      biasdist = dist - (bias[i] >> (intbiasshift - netbiasshift));
      if (biasdist < bestbiasd) {
        bestbiasd = biasdist;
        bestbiaspos = i;
      }

      betafreq = freq[i] >> betashift;
      freq[i] -= betafreq;
      bias[i] += betafreq << gammashift;
    }

    freq[bestpos] += beta;
    bias[bestpos] -= betagamma;

    return bestbiaspos;
  }

  /*
   * Sort network and build netindex[0..255]
   */
  function inxbuild() {
    let i, j, p, q, smallpos, smallval, previouscol, startpos;

    previouscol = 0;
    startpos = 0;

    for (i = 0; i < netsize; i++) {
      p = network[i];
      smallpos = i;
      smallval = p[1]; // index on g

      // find smallest in i..netsize-1
      for (j = i + 1; j < netsize; j++) {
        q = network[j];
        if (q[1] < smallval) {
          // index on g
          smallpos = j;
          smallval = q[1]; // index on g
        }
      }

      q = network[smallpos];

      // swap p (i) and q (smallpos) entries
      if (i != smallpos) {
        j = q[0];
        q[0] = p[0];
        p[0] = j;
        j = q[1];
        q[1] = p[1];
        p[1] = j;
        j = q[2];
        q[2] = p[2];
        p[2] = j;
        j = q[3];
        q[3] = p[3];
        p[3] = j;
      }

      // smallval entry is now in position i
      if (smallval != previouscol) {
        netindex[previouscol] = (startpos + i) >> 1;
        for (j = previouscol + 1; j < smallval; j++) netindex[j] = i;
        previouscol = smallval;
        startpos = i;
      }
    }

    netindex[previouscol] = (startpos + maxnetpos) >> 1;
    for (j = previouscol + 1; j < 256; j++) netindex[j] = maxnetpos; // really 256
  }

  /*
   * Search for BGR values 0..255 and return colour index
   */
  function inxsearch(b, g, r) {
    let a, p, dist;

    let bestd = 1000; // biggest possible dist is 256*3
    let best = -1;

    let i = netindex[g]; // index on g
    let j = i - 1; // start at netindex[g] and work outwards

    while (i < netsize || j >= 0) {
      if (i < netsize) {
        p = network[i];
        dist = p[1] - g; // inx key
        if (dist >= bestd) i = netsize;
        // stop iter
        else {
          i++;
          if (dist < 0) dist = -dist;
          a = p[0] - b;
          if (a < 0) a = -a;
          dist += a;
          if (dist < bestd) {
            a = p[2] - r;
            if (a < 0) a = -a;
            dist += a;
            if (dist < bestd) {
              bestd = dist;
              best = p[3];
            }
          }
        }
      }

      if (j >= 0) {
        p = network[j];
        dist = g - p[1]; // inx key - reverse dif
        if (dist >= bestd) j = -1;
        // stop iter
        else {
          j--;
          if (dist < 0) dist = -dist;
          a = p[0] - b;
          if (a < 0) a = -a;
          dist += a;
          if (dist < bestd) {
            a = p[2] - r;
            if (a < 0) a = -a;
            dist += a;
            if (dist < bestd) {
              bestd = dist;
              best = p[3];
            }
          }
        }
      }
    }

    return best;
  }

  /*
   * Main Learning Loop
   */
  function learn() {
    let i;

    const lengthcount = pixels.length;
    const alphadec = 30 + (samplefac - 1) / 3;
    const samplepixels = lengthcount / (3 * samplefac);
    let delta = ~~(samplepixels / ncycles);
    let alpha = initalpha;
    let radius = initradius;

    let rad = radius >> radiusbiasshift;

    if (rad <= 1) rad = 0;
    for (i = 0; i < rad; i++) {
      radpower[i] = alpha * (((rad * rad - i * i) * radbias) / (rad * rad));
    }

    let step;
    if (lengthcount < minpicturebytes) {
      samplefac = 1;
      step = 3;
    } else if (lengthcount % prime1 !== 0) {
      step = 3 * prime1;
    } else if (lengthcount % prime2 !== 0) {
      step = 3 * prime2;
    } else if (lengthcount % prime3 !== 0) {
      step = 3 * prime3;
    } else {
      step = 3 * prime4;
    }

    let b, g, r, j;
    let pix = 0; // current pixel

    i = 0;
    while (i < samplepixels) {
      b = (pixels[pix] & 0xff) << netbiasshift;
      g = (pixels[pix + 1] & 0xff) << netbiasshift;
      r = (pixels[pix + 2] & 0xff) << netbiasshift;

      j = contest(b, g, r);

      altersingle(alpha, j, b, g, r);
      if (rad !== 0) alterneigh(rad, j, b, g, r); // alter neighbours

      pix += step;
      if (pix >= lengthcount) pix -= lengthcount;

      i++;

      if (delta === 0) delta = 1;

      if (i % delta === 0) {
        alpha -= alpha / alphadec;
        radius -= radius / radiusdec;
        rad = radius >> radiusbiasshift;

        if (rad <= 1) rad = 0;
        for (j = 0; j < rad; j++) {
          radpower[j] = alpha * (((rad * rad - j * j) * radbias) / (rad * rad));
        }
      }
    }
  }

  /*
   * buildColormap: run the learning + build the index. Call before getColormap/lookupRGB.
   */
  this.buildColormap = function () {
    init();
    learn();
    unbiasnet();
    inxbuild();
  };

  /*
   * getColormap: returns the palette as a flat array [r,g,b, r,g,b, ...] (netsize*3).
   */
  this.getColormap = function () {
    const map = [];
    const index = [];

    for (let i = 0; i < netsize; i++) index[network[i][3]] = i;

    let k = 0;
    for (let l = 0; l < netsize; l++) {
      const j = index[l];
      map[k++] = network[j][0] & 0xff;
      map[k++] = network[j][1] & 0xff;
      map[k++] = network[j][2] & 0xff;
    }
    return map;
  };

  /*
   * lookupRGB(b, g, r): return the palette index closest to (b,g,r).
   * Note: NeuQuant's internal order is (b, g, r) — pass blue first.
   */
  this.lookupRGB = inxsearch;
}
