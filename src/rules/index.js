// src/rules/index.js — registry of playable games (rulesets).
//
// A ruleset is a plain object implementing the interface documented in
// game.js. To add a new game, write a module that exports one of these objects
// and register it here — nothing else in the app needs to change.
//
//   meta:   { id, name }
//   rack(ctx)            -> [ballSpec, ...]      ctx = { tableW, tableH }
//   init(match)          -> void                 set opening phase + message
//   snapshot(match)      -> any                  pre-shot state legality needs
//   resolve(shot, match) -> decision             judge a finished shot
//   hud(match)           -> { chips, status }    strings for the sidebar
import { eightBall } from './eightball.js';
import { nineBall } from './nineball.js';

const REGISTRY = {
  [eightBall.meta.id]: eightBall,
  [nineBall.meta.id]: nineBall,
};

export const defaultRulesetId = eightBall.meta.id;

export function getRuleset(id) {
  return REGISTRY[id] || REGISTRY[defaultRulesetId];
}

// [{ id, name }, ...] for building a game picker.
export function listRulesets() {
  return Object.values(REGISTRY).map(r => ({ id: r.meta.id, name: r.meta.name }));
}
