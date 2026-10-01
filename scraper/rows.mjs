// Compact row layouts for the state files, shared by the scraper and the map Elo fit.

// Battles, one file per UTC day under state/battles:
// [id, at, ranked, challenge, aId, bId, aElo, bElo, winsA, winsB, games, dA, dB, replayId]
export const B = { id: 0, at: 1, ranked: 2, challenge: 3, a: 4, b: 5, aElo: 6, bElo: 7, wa: 8, wb: 9, n: 10, dA: 11, dB: 12, replay: 13 };

// Games, one file per UTC day under state/games:
// [id, at, kind, aId, bId, mapId, winner]
// kind is a bit set (GK); winner is 1 for A, 2 for B, 0 for a draw.
export const G = { id: 0, at: 1, kind: 2, a: 3, b: 4, map: 5, win: 6 };
export const GK = { ranked: 1, challenge: 2, tournament: 4 };
