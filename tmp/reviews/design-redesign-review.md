# Design Redesign Review

Verdict: BLOCK

The redesign is calmer and visually coherent, but it does not yet meet the requested bar: one committed visual world grounded in Indian/chaturanga/gaja heritage, specifically Mewar/Rajasthani miniature construction.

Blocking findings:
- Heritage grounding is shallow. The elephant mark is a modern outline icon, pieces are standard Unicode chess glyphs, and the board decoration is limited to a simple circular overlay. See `src/main.tsx:70`, `src/main.tsx:722`, `src/styles.css:570-655`, screenshots #3, #4, #6.
- Forms still read as generic web controls. Native inputs/selects and browser dropdowns dominate dashboard flows. See `src/styles.css:103-119`, `src/main.tsx:376-443`, screenshots #1, #2, #5.
- Dashboard center of gravity is setup/admin, not board/game state. Games are last in the grid and visually secondary. See `src/styles.css:272-280`, screenshots #1, #2, #5.
- The visual language is consistent parchment styling, but not yet a fully committed Mewar/Rajasthani miniature construction system across panels, empty states, controls, board, clocks, and history.

Required fixes:
- Create a stricter miniature-derived visual system: border grammar, flat registers, ornamental construction, piece motifs, and gaja/chaturanga references.
- Replace generic form treatments with world-native controls.
- Promote games, board state, clocks, and scheduled play as the dashboard's dominant objects.
- Apply the same art direction to empty states, list rows, buttons, game history, and terminal states.

Positive notes:
- Live game screenshots make board and clocks the main focus.
- Mobile screenshots show no obvious overlap or horizontal jank.
- The calm friends-only thesis is preserved with no ratings, feeds, streaks, or matchmaking.
