export type LyricCharacterPayload = {
  text: string;
  startTime: number;
  endTime: number;
};

export type LyricLinePayload = {
  time: number;
  text: string;
  translated?: string;
  romanized?: string;
  characters: LyricCharacterPayload[];
};
