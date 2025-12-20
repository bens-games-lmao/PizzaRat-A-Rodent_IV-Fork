export interface CharacterStrength {
  targetElo?: number;
  useWeakening?: boolean;
  searchSkill?: number;
  selectivity?: number;
  slowMover?: number;
}

export interface CharacterTimeConfig {
  timePercentage?: number;
  timeNervousness?: number;
  blitzHustle?: number;
  minThinkTimePercent?: number;
}

export interface CharacterBooksConfig {
  guideBookFile?: string;
  mainBookFile?: string;
  maxMainBookPly?: number;
  bookFilter?: number;
}

export interface CharacterProfile {
  id?: string;
  description?: string;
  strength?: CharacterStrength;
  books?: CharacterBooksConfig;
  time?: CharacterTimeConfig;
}

export interface CharacterSummary {
  id: string;
  description?: string;
  elo?: number | null;
}

export interface EngineMoveRequest {
  fen: string;
  sideToMove: string;
  targetElo: number | null;
}

export interface EngineMoveResult {
  bestmove: string | null;
}

declare global {
  interface Window {
    cozyChess?: {
      listCharacters: () => Promise<CharacterSummary[]>;
      getCharacter: (id: string) => Promise<CharacterProfile>;
      startNewGame: (options: { profile: CharacterProfile | null; playerColor: "white" | "black" }) => Promise<void>;
      requestEngineMove: (payload: EngineMoveRequest) => Promise<EngineMoveResult>;
    };
  }
}

function ensureBridge(): NonNullable<Window["cozyChess"]> {
  if (!window.cozyChess) {
    throw new Error("Cozy Chess IPC bridge is not available (preload not loaded).");
  }
  return window.cozyChess;
}

export const cozyApi = {
  async listCharacters(): Promise<CharacterSummary[]> {
    const bridge = ensureBridge();
    return bridge.listCharacters();
  },

  async getCharacter(id: string): Promise<CharacterProfile> {
    const bridge = ensureBridge();
    return bridge.getCharacter(id);
  },

  async startNewGame(options: { profile: CharacterProfile | null; playerColor: "white" | "black" }): Promise<void> {
    const bridge = ensureBridge();
    await bridge.startNewGame(options);
  },

  async requestEngineMove(payload: EngineMoveRequest): Promise<EngineMoveResult> {
    const bridge = ensureBridge();
    return bridge.requestEngineMove(payload);
  }
};


