# Third-party notices

## License scope

The root [MIT License](LICENSE) applies to the project's original code and original textual documentation, as described in [README.md](README.md#license). It does not relicense third-party code or media assets. All files in `assets/` and `docs/images/`, including Pokémon sprites, reference artwork, fonts, audio, generated videos, and screenshots, are outside the project's MIT grant. Third-party components and fonts retain their existing licenses; the original notices and license files below remain applicable. No Pokémon character, artwork, name, design, or trademark rights are granted.

## Fusion Pixel Font

The unmodified Simplified Chinese 12px monospaced font in `assets/fonts/fusion-pixel-12px-monospaced-zh_hans.woff2` comes from [TakWolf / Fusion Pixel Font, release 2026.09.01](https://github.com/TakWolf/fusion-pixel-font/releases/tag/2026.09.01), package `fusion-pixel-font-12px-monospaced-otf.woff2-v2026.09.01.zip`. Only the filename was shortened; the font binary is unchanged.

Copyright (c) 2022, TakWolf. Licensed under SIL Open Font License 1.1. The release's complete license is preserved in `assets/fonts/OFL.txt`, including the bundled upstream notices in `assets/fonts/LICENSES/` (Ark Pixel, Cubic 11, Galmuri). This font license does not license Pokémon characters or artwork. Font files are served locally; the webpage does not contact a font CDN.

## PokéAPI sprite details

The non-pixel identity references in `assets/video-references/artwork/` are the unmodified PNGs from `PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{dex}.png` (retrieved 2026-09-05): Pikachu #25, Squirtle #7, Bulbasaur #1, Charmander #4, Geodude #74 and Gastly #92. These references are used server-side for AI battle/entrance identity conditioning; pixel sprites are reserved for UI and fallback rendering. Public availability is not a license to Pokémon character rights, and non-commercial use is not a blanket permission from the rights holders.

The animated Generation V sprites in `assets/sprites/` were retrieved from the public [PokeAPI/sprites](https://github.com/PokeAPI/sprites) repository.

Files used:

- `pikachu-back.gif` — Pokémon #25, animated back sprite
- `squirtle-back.gif` — Pokémon #7, animated back sprite
- `bulbasaur-back.gif` — Pokémon #1, animated back sprite
- `charmander-front.gif` — Pokémon #4, animated front sprite
- `charizard-front.gif` — Pokémon #6, animated front sprite (retrieved 2026-09-07)
- `geodude-front.gif` — Pokémon #74, animated front sprite
- `gastly-front.gif` — Pokémon #92, animated front sprite
- `dragonite-front.gif` — Pokémon #149, animated front sprite (retrieved 2026-09-06)
- `gengar-front.gif` — Pokémon #94, animated front sprite (retrieved 2026-09-06)

Dragonite #149 and Gengar #94 were added on 2026-09-06 from the same repository: unmodified `sprites/pokemon/other/official-artwork/{dex}.png` for non-pixel identity references, `sprites/pokemon/versions/generation-v/black-white/animated/{dex}.gif` for UI/fallback, and `sprites/pokemon/versions/generation-v/black-white/{dex}.png` for the legacy pixel-reference path. Their stats, types and learnable moves, plus Dragon Claw's battle values, were checked against `https://pokeapi.co/api/v2/pokemon/dragonite`, `https://pokeapi.co/api/v2/pokemon/gengar` and `https://pokeapi.co/api/v2/move/dragon-claw` on that date. Geodude/Gastly assets remain available for old cached battles and tests.

Charizard #6 was added on 2026-09-07 from the same three unmodified sprite/artwork paths above with `{dex}=6`. Its stats, fire/flying types and selected learnable moves (Ember, Dragon Claw, Iron Tail, Smokescreen) were checked against `https://pokeapi.co/api/v2/pokemon/charizard`. The default opposing team is now Charmander, Charizard, Gengar; Dragonite data and assets remain for historical battles. No new AI video was generated for this roster change.

The upstream notice states that all image contents are copyright The Pokémon Company, while the repository is distributed under CC0 1.0 Universal. Pokémon character names, designs, and imagery remain the property of their respective rights holders. This local project is a non-commercial educational prototype and is not affiliated with or endorsed by Nintendo, GAME FREAK, or The Pokémon Company.
