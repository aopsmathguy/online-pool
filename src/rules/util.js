// src/rules/util.js — small helpers shared by rulesets.

// Fisher-Yates in-place shuffle. Returns the same array for chaining.
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
