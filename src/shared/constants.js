// src/constants.js
export const tableW = 2.24, tableH = 1.12;
export const R = 0.028575, m = 0.170097, g = 9.81;

export const e_ball  = Math.sqrt(0.95);   // ball·ball combine = 0.95
export const e_rail  = 0.98 / e_ball;      // ball·rail combine = 0.85
export const e_table = 0.6 / e_ball;
export const e_pocket = 0.2/e_ball;

// Coefficients the analytic friction pass actually uses (see applyFriction).
// The cloth/rail kinetic values are exactly the old combined products, so
// sliding behaviour matches what Bullet used to apply.
export const mu_felt_kinetic = 0.20;   // cloth slide→roll friction (was mu_ball·mu_ground)
export const mu_rail_kinetic = 0.14;   // rail tangential friction
export const mu_cup_kinetic  = 0.30;   // pocket-cup slide friction (plastic/rubber, grippier
                                       // than cloth) — bleeds off a ball rattling in the cup

// Ball–ball dynamic friction FALLS with the relative tangential surface speed s
// (m/s) at contact, which is what makes object-ball throw depend on shot speed
// (soft shots throw more, firm shots less). Empirical fit for clean pool balls
// (Marlow's data, per Alciatore):
//   mu(s) = mu_ball_asym + mu_ball_amp · exp(−mu_ball_decay · s)
export const mu_ball_asym  = 0.009951;  // high-speed asymptote
export const mu_ball_amp   = 0.108;     // extra friction as s → 0 (μ(0) = asym + amp ≈ 0.118)
export const mu_ball_decay = 1.088;     // per (m/s), how fast the coefficient falls with speed

export const rollingFric = 0.000;
export const spinningFric = 0.000;

// The two TUNING KNOBS for cloth friction, both expressed as the deceleration a
// ball actually experiences rolling/spinning on the flat felt. They are stated
// this way rather than as raw coefficients because that is the quantity you can
// observe on the table — and because ai.js aims with A_FELT = mu_felt_linear*g,
// so the number the AI models and the number the physics applies are the same.
export const mu_felt_linear = 0.01;      // linear decel = mu_felt_linear * g  (m/s^2)
export const spin_decel_rad_s2 = 10;     // spin decel about the surface normal (rad/s^2)

// Contact friction coefficients, consumed by applyContactFriction in
// src/server/physics.js. The friction pass works in FORCES — a rolling
// resistance F = -C_rr*N*v̂ and a spin torque tau = -C_spin*N*R*sign(w·n)*n —
// so the knobs above have to be converted into coefficients. On the flat felt a
// resting ball has N = m*g exactly, which is what makes the conversion exact:
//
//   linear:  a     = C_rr*N/m       = C_rr*g            =>  C_rr   = mu_felt_linear
//   spin:    dw/dt = C_spin*N*R/I   = 5*C_spin*g/(2*R)  =>  C_spin = 2*R*spin_decel/(5*g)
//
// using I = (2/5)*m*R^2 for a solid sphere. Derived rather than written out as
// decimals so that retuning a knob above cannot silently desync the two.
export const C_rr   = mu_felt_linear;
export const C_spin = 2 * R * spin_decel_rad_s2 / (5 * g);

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
