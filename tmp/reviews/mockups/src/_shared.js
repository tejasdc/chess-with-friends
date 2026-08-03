// Shared helpers for all mockup pages. Generates board DOM + populates fake
// state so mockups can be inspected as complete surfaces without a backend.

const FILLED = { k:"♚", q:"♛", r:"♜", b:"♝", n:"♞", p:"♟" };

// Standard chess board coord grid. `orientation` = "w" means rank 8 on top.
// `overlay` = optional map { "e4": "legal-dot", "e2": "selected" }.
function makeBoard(fen, orientation = "w", overlay = {}) {
  const rows = fen.split(" ")[0].split("/");
  const filesW = ["a","b","c","d","e","f","g","h"];
  const files = orientation === "w" ? filesW : [...filesW].reverse();
  const ranks = orientation === "w" ? ["8","7","6","5","4","3","2","1"] : ["1","2","3","4","5","6","7","8"];
  const el = document.createElement("div");
  el.className = "board";
  for (const rank of ranks) {
    for (const file of files) {
      const sq = `${file}${rank}`;
      const rowIdx = 8 - Number(rank);
      const fileIdx = filesW.indexOf(file);
      const dark = (fileIdx + Number(rank)) % 2 === 0;
      const row = rows[rowIdx];
      // Expand FEN row to 8 chars
      let expanded = "";
      for (const ch of row) {
        if (/\d/.test(ch)) expanded += " ".repeat(Number(ch));
        else expanded += ch;
      }
      const piece = expanded[fileIdx];
      const cell = document.createElement("div");
      cell.className = `sq ${dark ? "dark" : "light"}`;
      // Only STATE classes go on the square (positioning stays intact).
      // Child overlays (legal-dot / legal-capture) are appended below,
      // NOT added as classes to .sq — otherwise the square inherits the
      // overlay's absolute positioning and takes over the whole board.
      const stateClasses = new Set(["selected", "last-from", "last-to", "in-check"]);
      if (overlay[sq] && stateClasses.has(overlay[sq])) cell.classList.add(overlay[sq]);
      cell.dataset.sq = sq;
      if (piece && piece !== " ") {
        const color = piece === piece.toUpperCase() ? "w" : "b";
        const type = piece.toLowerCase();
        const span = document.createElement("span");
        span.className = `piece p${color}`;
        span.textContent = FILLED[type];
        cell.appendChild(span);
      }
      // Legal dot / capture ring overlay
      if (overlay[sq] === "legal-dot" || overlay[sq] === "legal-move") {
        const dot = document.createElement("span");
        dot.className = "legal-dot";
        cell.appendChild(dot);
      }
      if (overlay[sq] === "legal-capture") {
        const cap = document.createElement("span");
        cap.className = "legal-capture";
        cell.appendChild(cap);
      }
      el.appendChild(cell);
    }
  }
  return el;
}

function mount(selector, fen, orientation, overlay) {
  const target = document.querySelector(selector);
  if (!target) return;
  target.innerHTML = "";
  target.appendChild(makeBoard(fen, orientation, overlay));
}

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// A mid-game position: after 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7
const MID_FEN = "r1bq1rk1/1ppp1ppp/p1n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQ1RK1 w - - 0 6";
