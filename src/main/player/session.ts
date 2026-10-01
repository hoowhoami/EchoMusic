import {
  matchesPlayerSession,
  type PlayerRuntimeSession,
  type PlayerSessionRestore,
  type PlayerSessionTransport,
} from '../../shared/playerSession';

export const createPlayerSessionCache = () => {
  let session: PlayerRuntimeSession | null = null;
  let owner: object | null = null;
  return {
    clear() {
      session = null;
      owner = null;
    },
    sync(
      next: PlayerRuntimeSession,
      engine: object | null,
      transport: PlayerSessionTransport | null,
    ) {
      if (!engine || !matchesPlayerSession(next, transport)) return;
      session = next;
      owner = engine;
    },
    get(
      engine: object | null,
      transport: PlayerSessionTransport | null,
    ): PlayerSessionRestore | null {
      if (owner !== engine || !matchesPlayerSession(session, transport)) return null;
      return { session: session!, transport: transport! };
    },
  };
};
