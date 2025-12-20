export type PlyAuthor = "human" | "engine";

export interface Ply {
  by: PlyAuthor;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
}

export interface GameHistory {
  initialFen: string;
  done: Ply[];
  undone: Ply[];
}

export interface RecordHumanMoveResult {
  history: GameHistory;
  appliedPlies: Ply[];
  reusedEngine: Ply | null;
}

export function createInitialHistory(initialFen: string): GameHistory {
  return {
    initialFen,
    done: [],
    undone: []
  };
}

export function getCurrentFen(history: GameHistory): string {
  if (history.done.length === 0) {
    return history.initialFen;
  }
  return history.done[history.done.length - 1].fenAfter;
}

export function canUndo(history: GameHistory): boolean {
  return history.done.length > 0;
}

export function canRedo(history: GameHistory): boolean {
  return history.undone.length > 0;
}

export function undoLast(history: GameHistory): GameHistory {
  if (!canUndo(history)) {
    return history;
  }

  const done = history.done.slice();
  const undone = history.undone.slice();

  const last = done.pop() as Ply;
  const popped: Ply[] = [last];

  if (last.by === "engine" && done.length > 0) {
    const prev = done[done.length - 1];
    if (prev.by === "human") {
      popped.unshift(done.pop() as Ply);
    }
  }

  const next: GameHistory = {
    initialFen: history.initialFen,
    done,
    undone: popped.concat(undone)
  };

  return next;
}

export function redoLast(history: GameHistory): GameHistory {
  if (!canRedo(history)) {
    return history;
  }

  const done = history.done.slice();
  const undone = history.undone.slice();

  const first = undone.shift() as Ply;
  const toApply: Ply[] = [first];

  if (first.by === "human" && undone.length > 0) {
    const second = undone[0];
    if (second.by === "engine" && second.fenBefore === first.fenAfter) {
      toApply.push(undone.shift() as Ply);
    }
  }

  const next: GameHistory = {
    initialFen: history.initialFen,
    done: done.concat(toApply),
    undone
  };

  return next;
}

export function recordHumanMove(history: GameHistory, candidate: Ply): RecordHumanMoveResult {
  const done = history.done.slice();
  let undone = history.undone.slice();

  if (undone.length >= 2) {
    const first = undone[0];
    const second = undone[1];

    if (
      first.by === "human" &&
      second.by === "engine" &&
      first.uci === candidate.uci &&
      first.fenBefore === candidate.fenBefore &&
      second.fenBefore === first.fenAfter
    ) {
      undone = undone.slice(2);
      done.push(first, second);

      const nextHistory: GameHistory = {
        initialFen: history.initialFen,
        done,
        undone
      };

      return {
        history: nextHistory,
        appliedPlies: [first, second],
        reusedEngine: second
      };
    }
  }

  done.push(candidate);
  undone = [];

  const nextHistory: GameHistory = {
    initialFen: history.initialFen,
    done,
    undone
  };

  return {
    history: nextHistory,
    appliedPlies: [candidate],
    reusedEngine: null
  };
}

export function recordEngineMove(history: GameHistory, enginePly: Ply): GameHistory {
  const done = history.done.slice();
  done.push(enginePly);

  return {
    initialFen: history.initialFen,
    done,
    undone: history.undone.slice()
  };
}

export interface MoveListItem {
  index: number;
  white?: string;
  black?: string;
}

export function flattenPliesToMoveList(plies: Ply[]): MoveListItem[] {
  const result: MoveListItem[] = [];

  let moveIndex = 1;
  for (let i = 0; i < plies.length; ) {
    const first = plies[i];
    const second = plies[i + 1];

    if (!first) break;

    if (first.fenBefore.split(" ")[1] === "w") {
      const item: MoveListItem = {
        index: moveIndex,
        white: first.by === "engine" || first.by === "human" ? first.san : undefined
      };

      if (second) {
        item.black = second.san;
        i += 2;
      } else {
        i += 1;
      }

      result.push(item);
      moveIndex += 1;
    } else {
      const item: MoveListItem = {
        index: moveIndex,
        black: first.san
      };
      result.push(item);
      moveIndex += 1;
      i += 1;
    }
  }

  return result;
}


