export const DEFAULT_IDLE_VIDEO_MATCHUP = Object.freeze({
  player: "pikachu",
  opponent: "charmander",
});

export function supportsDefaultIdleVideo(player, opponent) {
  return player?.speciesId === DEFAULT_IDLE_VIDEO_MATCHUP.player
    && opponent?.speciesId === DEFAULT_IDLE_VIDEO_MATCHUP.opponent
    && player.hp > 0
    && opponent.hp > 0
    && !player.status && !opponent.status
    && !player.confused && !opponent.confused
    && !player.volatile?.confusedTurns && !opponent.volatile?.confusedTurns;
}
