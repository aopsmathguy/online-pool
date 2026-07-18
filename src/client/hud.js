// src/hud.js — render the top-middle player names + status from a gameState
// packet (client-only). The spin/power/view/pocketed HUD lives on the overlay
// canvas (hudCanvas.js). Driven by a plain state object the server sends.

export function renderHUD(gs) {
  const playersEl = document.getElementById('players');
  const groupEl = document.getElementById('groupInfo');
  const msgEl = document.getElementById('gameMsg');
  const banner = document.getElementById('banner');
  const over = gs.winner >= 0;

  // Both names side by side; the player whose turn it is (chip.active) is bold +
  // underlined via the `active` class.
  if (playersEl) {
    playersEl.innerHTML = '';
    gs.chips.forEach((chip, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'playerSep'; sep.textContent = 'vs';
        playersEl.appendChild(sep);
      }
      const el = document.createElement('span');
      el.className = 'playerName' + (chip.active ? ' active' : '');
      el.textContent = chip.text;
      playersEl.appendChild(el);
    });
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
