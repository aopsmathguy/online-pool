// src/balldefs.js — ball colours + solid/stripe styling by number.
// Three-free so both the server (rack layout) and client (textures) can use it.
// Matched to real (Aramith-style) ball colours: chrome yellow, royal blue,
// deep red, dark purple, burnt orange, forest green, maroon, near-black.
export const BALL_COLORS = {
  1:"#fdc500", 2:"#1450a8", 3:"#d62e2a", 4:"#5f2a84", 5:"#f1731f",
  6:"#0a6b36", 7:"#8a3324", 8:"#131313",
  9:"#fdc500",10:"#1450a8",11:"#d62e2a",12:"#5f2a84",13:"#f1731f",
  14:"#0a6b36",15:"#8a3324"
};

export const ballStyle = n => (n == null ? "cue" : n <= 8 ? "solid" : "stripe");
