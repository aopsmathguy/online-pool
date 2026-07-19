// src/server/loopbackSocket.js — an in-process socket pair.
//
// Two endpoints wired back to back: whatever one `emit`s, the other's `on`
// handlers receive. Same surface the real SocketClient exposes to the server
// (`on`, `emit`), so code that talks to a client cannot tell the difference.
//
// This is what lets the computer opponent be an ordinary PLAYER rather than a
// subsystem: it holds one end, the server's normal connection handler holds the
// other, and the bot's shots go through the very same validated `shoot` /
// `placeMove` / `placeConfirm` handlers a human's do. No packets are encoded —
// objects are passed by reference — so it costs nothing.
//
// Delivery is SYNCHRONOUS, which differs from a real socket. That is what we
// want here (the bot acts from its own timers, never from inside a handler it
// is reentering), but it does mean an endpoint must not emit back into a
// handler that is still on the stack. Nothing here does.
export function createLoopbackPair() {
  const a = makeEnd();
  const b = makeEnd();
  a._peer = b;
  b._peer = a;
  return { a, b };
}

function makeEnd() {
  const listeners = new Map();   // event -> [handler]
  return {
    _peer: null,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return this;
    },
    emit(event, data) {
      const hs = this._peer && this._peer._listenersFor(event);
      if (!hs) return;
      // A throwing handler must not take the whole server down (this runs
      // in-process, so an uncaught error would escape into whatever timer
      // called it), but it must not vanish either. The real socket path wraps
      // handler errors in a "Packet doesn't fit schema" log, which is how a
      // genuine bug in the `aim` handler stayed hidden for the life of the
      // project — so say plainly what happened.
      for (const h of hs.slice()) {
        try { h(data); }
        catch (err) { console.error(`[loopback] handler for '${event}' threw:`, err); }
      }
    },
    _listenersFor(event) { return listeners.get(event) || null; },
    // Deliver an event to THIS end's own handlers (used to open the connection).
    _deliver(event, data) {
      const hs = listeners.get(event);
      if (hs) for (const h of hs.slice()) h(data);
    },
  };
}
