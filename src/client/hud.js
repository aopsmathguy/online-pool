// src/hud.js — render the sidebar HUD from a gameState packet (client-only).
// Ported from the old game.js updateHUD, but driven by a plain state object the
// server sends instead of local match state.

export function renderHUD(gs) {
  const turnEl = document.getElementById('turnInfo');
  const groupEl = document.getElementById('groupInfo');
  const msgEl = document.getElementById('gameMsg');
  const banner = document.getElementById('banner');
  const over = gs.winner >= 0;

  if (turnEl) {
    turnEl.innerHTML = '';
    for (const chip of gs.chips) {
      const el = document.createElement('div');
      el.className = 'playerChip' + (chip.active ? ' active' : '');
      el.textContent = chip.text;
      turnEl.appendChild(el);
    }
  }
  if (groupEl) groupEl.textContent = gs.status || '';
  if (msgEl) {
    msgEl.textContent = gs.message || '';
    msgEl.classList.toggle('foul', gs.ballInHand);
  }
  if (banner) {
    if (over) { banner.textContent = gs.message; banner.classList.add('show'); }
    else banner.classList.remove('show');
  }
}

export function renderPocketed(pocketed) {
  const el = document.getElementById('pocketed');
  if (!el) return;
  el.textContent = pocketed && pocketed.length ? pocketed.map(n => `#${n}`).join(' ') : '(none)';
}
