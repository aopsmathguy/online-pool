// src/constants.js
export const tableW = 2.24, tableH = 1.12;
export const R = 0.028575, m = 0.170097, g = 9.81;

export const e_ball  = Math.sqrt(0.95);
export const e_rail  = 0.8 / e_ball;
export const e_table = 0.6 / e_ball;
export const e_pocket = 0/e_ball;

export const mu_ball   = Math.sqrt(0.06);
export const mu_wall   = 0.1 / mu_ball;
export const mu_ground = 0.2 / mu_ball;
export const mu_pocket = 0.3/mu_ball;

export const rollingFric = 0.000;
export const spinningFric = 0.000;

export const mu_felt_linear = 0.01;
export const spin_decel_rad_s2 = 10;

export const wireY = 0.034925;
export const rodR  = 0.005;
export const inset = 0.05;

// Pocket cups hang below the felt. The rim sits just under the surface so a
// ball tipping over the lip drops straight in; the cup runs cupDepth down from
// there. Server (physics cup) and client (cup mesh) must use the same numbers,
// or a pocketed ball rests at a height the visual cup floor isn't at.
export const cupDepth = 0.1333;
export const cupRimY  = -0.01;
export const cupY     = cupRimY - cupDepth * 0.5;
export const cupR     = 0.075;
// Thickness of the cup's base disc. It is CENTRED on the cup floor, so half of
// it hangs below — which is what the cabinet has to reach down past to cover it.
export const cupBase  = 0.01;

// The rails' outer edge stands 1/8" proud of the nose, so the top face slants
// inward and down rather than lying flat — the cross-section stops being a
// trapezoid and keeps just one right angle, at the outer-bottom corner. The
// NOSE stays at wireY, so this changes the look and not the playing surface.
// The pocket wire rides at the same raised height because its ends meet the
// rails' outer-top corners; lifting one without the other would open a gap.
export const rail_rise = 0.0254 / 8;
export const pocketWireY = wireY + rail_rise;

// The rail top is two segments, not one: a flat cap `rail_cap` wide sitting at
// the raised outer height, then a shallow slant running in and down from the
// crest to the nose. That makes the cross-section a pentagon. Widen this and
// the flat grows while the slant steepens; it must stay under `inset`.
export const rail_cap = inset / 2;

// The wooden cabinet. Every horizontal cross-section is a rounded rectangle
// whose four corner arcs are centred on the four CORNER pockets, so one radius
// fixes the whole outline: the straight sides are just the tangents between
// consecutive arcs, and they travel outward with the radius. It tapers from
// cabinetRTop at the rail line down to cabinetRBottom at the cup floor.
//
// cabinetRBottom is 0.110 rather than cupR because the two MIDDLE pockets sit
// further out than the corner ones (z = tableH/2 + 0.05 vs + 0.015). A section
// of radius cupR would put the straight sides at |z| = 0.650, which is inside
// the middle cups' outer wall at 0.685 — they'd poke through the wood. 0.110 is
// the radius that lands the sides exactly tangent to those cups instead, so the
// bottom section hugs all six cups at once.
export const cabinetRBottom = 0.110;
export const cabinetRTop    = cabinetRBottom + 0.035;

// The bullnose along the cabinet's top outer edge: a quarter-round rolling from
// the deck's flat down onto the skirt, all the way around the loop. Because a
// section is fixed by its radius alone, the roll is just a run of sections whose
// radius sweeps a quarter circle inward — the widest one still lands at
// cabinetRTop, so the table's footprint is unchanged and only the DECK loses
// this much width. That flat is 0.13 m wide (inset out to cabinetRTop + 0.015),
// so this has room to grow, but past ~0.03 it starts crowding the rail line.
export const cabinetEdgeR = 0.018;

// The deck is the flat ring of wood that closes the cabinet off at the top — a
// single face with no thickness, so it has no underside to see. It sits at
// pocketWireY, which is the rail top and the wire's axis at once — the two are
// the same height — so it is flush with the rails and passes through the middle
// of the rod, leaving the wire half-sunk.
export const cabinetYTop = pocketWireY;   // rail top = wire axis = deck face
// The underside of the cup's base disc, not the cup floor: stopping at the floor
// leaves the lower half of that disc showing beneath the wood at the middle
// pockets, where the section is tangent to the cups and hides nothing. It is
// also where the cabinet's bottom face lies, and that face wants to land flush
// with the cups rather than slice through them.
export const cabinetYBottom = cupY - cupDepth * 0.5 - cupBase * 0.5;

export const mid_mouth = 0.132;
export const mid_throat = 0.112;
export const corner_mouth = 0.117;
export const corner_throat = 0.112;

// Physics substep (250 Hz). Shots are simulated synchronously on the server
// (see sim.js runShotAndRecord); this balances accuracy against how long a
// shot blocks the event loop. Replay keyframes are sampled every 4 substeps.
export const FIXED_DT = 0.004;
export const TEX_V_STRETCH = 2;

// Shared "number-up" ball orientation: the two numbered faces sit at local ±Z
// on the ball texture (u = 0.25/0.75 on the equator), so −90° about X points
// one number straight up. Server bodies are racked/spotted with THIS rotation
// and the client builds rack meshes with it too — they must match exactly,
// because no frames are streamed while the table is at rest, so any mismatch
// snap-rotates every ball on the first frame of the next shot's replay.
export const RACK_QUAT = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };

// Synthetic cue draw-back + strike prepended to every shot replay (client-side
// shotPlayer.js). The recording itself starts at the moment of contact, so this
// lead-in is what makes the stick visible before the balls move. The SERVER
// needs it too: replayUntil gates the next shot on how long everyone is still
// watching, and that window now includes this lead-in. Shared so the two can
// never drift apart.
export const SHOT_STRIKE_MS = 520;
