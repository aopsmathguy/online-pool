// lib/buffer.js — minimal browser Buffer polyfill for schemapack.js.
//
// schemapack does `import { Buffer } from 'buffer'` (native in Node). In the
// browser an import map maps 'buffer' → this file. It implements exactly the
// subset schemapack uses: static alloc/from/isBuffer/byteLength and the BE
// numeric + utf8 string + copy instance methods. Backed by a Uint8Array
// subclass so WebSocket.send() accepts instances directly.
const te = new TextEncoder();
const td = new TextDecoder('utf-8');

export class Buffer extends Uint8Array {
  static alloc(n)       { return new Buffer(n); }
  static allocUnsafe(n) { return new Buffer(n); }
  static isBuffer(x)    { return x instanceof Buffer; }

  static from(src, a, b) {
    if (src instanceof ArrayBuffer) return new Buffer(src, a || 0, b == null ? src.byteLength : b);
    if (ArrayBuffer.isView(src))    return new Buffer(src.buffer, src.byteOffset, src.byteLength);
    return new Buffer(src);   // array of byte values
  }

  static byteLength(str, enc) {
    if (str == null) return 0;
    return (!enc || enc === 'utf8' || enc === 'utf-8') ? te.encode(str).length : str.length;
  }

  get _dv() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }

  // Unsigned/signed integer + float, big-endian. Writers return next offset.
  writeUInt8(v, o)    { this[o] = v & 0xff; return o + 1; }
  readUInt8(o)        { return this[o]; }
  writeInt8(v, o)     { this._dv.setInt8(o, v);        return o + 1; }
  readInt8(o)         { return this._dv.getInt8(o); }
  writeUInt16BE(v, o) { this._dv.setUint16(o, v, false); return o + 2; }
  readUInt16BE(o)     { return this._dv.getUint16(o, false); }
  writeInt16BE(v, o)  { this._dv.setInt16(o, v, false);  return o + 2; }
  readInt16BE(o)      { return this._dv.getInt16(o, false); }
  writeUInt32BE(v, o) { this._dv.setUint32(o, v, false); return o + 4; }
  readUInt32BE(o)     { return this._dv.getUint32(o, false); }
  writeInt32BE(v, o)  { this._dv.setInt32(o, v, false);  return o + 4; }
  readInt32BE(o)      { return this._dv.getInt32(o, false); }
  writeFloatBE(v, o)  { this._dv.setFloat32(o, v, false); return o + 4; }
  readFloatBE(o)      { return this._dv.getFloat32(o, false); }
  writeDoubleBE(v, o) { this._dv.setFloat64(o, v, false); return o + 8; }
  readDoubleBE(o)     { return this._dv.getFloat64(o, false); }

  // utf8 string write/read.
  write(str, offset, len) {
    const bytes = te.encode(str || '');
    const n = Math.min(len == null ? bytes.length : len, bytes.length, this.length - offset);
    this.set(bytes.subarray(0, n), offset);
    return n;
  }
  toString(enc, start = 0, end = this.length) {
    return td.decode(this.subarray(start, end));
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    target.set(this.subarray(sourceStart, sourceEnd), targetStart);
    return sourceEnd - sourceStart;
  }
}

export default { Buffer };
