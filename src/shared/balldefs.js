// src/balldefs.js — ball colours + solid/stripe styling by number.
// Three-free so both the server (rack layout) and client (textures) can use it.
// Matched to real (Aramith-style) ball colours: chrome yellow, royal blue,
// deep red, dark purple, burnt orange, forest green, maroon, near-black.
export const BALL_COLORS = {
  1:"#EADC5D", 2:"#3879AB", 3:"#DB4841", 4:"#8985AB", 5:"#E78C48",
  6:"#4B8558", 7:"#A74343", 8:"#201E1F",
  9:"#EADC5D",10:"#3879AB",11:"#DB4841",12:"#8985AB",13:"#E78C48",
  14:"#4B8558",15:"#A74343"
};

export const ballStyle = n => (n == null ? "cue" : n <= 8 ? "solid" : "stripe");
