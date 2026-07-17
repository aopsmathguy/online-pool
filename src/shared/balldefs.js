// src/balldefs.js — ball colours + solid/stripe styling by number.
// Three-free so both the server (rack layout) and client (textures) can use it.
// Matched to real (Aramith-style) ball colours: chrome yellow, royal blue,
// deep red, dark purple, burnt orange, forest green, maroon, near-black.
export const BALL_COLORS = {
  1:"#ecec00",  2:"#0030E3",  3:"#FF0000",  4:"#4700FF",  5:"#FF8000",
  6:"#009010",  7:"#600000",  8:"#000000",
  9:"#ecec00", 10:"#0030E3", 11:"#FF0000", 12:"#4700FF", 13:"#FF8000",
 14:"#009010", 15:"#600000"
};

export const ballStyle = n => (n == null ? "cue" : n <= 8 ? "solid" : "stripe");
