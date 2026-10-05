/** Neutral skin hierarchy. Shell artwork and panel colors are separate layers. */
export const neutralThemePalette = (dark: boolean) =>
  dark
    ? {
        shell: '#171718',
        sidebar: '#171718',
        main: '#29292b',
        player: '#29292b',
        card: '#343436',
        elevated: '#29292b',
        text: '#ffffff',
        secondary: '#bcbcbc',
        border: '#444446',
      }
    : {
        shell: '#f6f6f6',
        sidebar: '#f6f6f6',
        main: '#ffffff',
        player: '#ffffff',
        card: '#f7f7f7',
        elevated: '#ffffff',
        text: '#000000',
        secondary: '#666666',
        border: '#dedede',
      };

export const DEFAULT_THEME_ACCENT = '#00cc65';
