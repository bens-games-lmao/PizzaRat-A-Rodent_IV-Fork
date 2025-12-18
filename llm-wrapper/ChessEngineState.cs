using System.Collections.Generic;

namespace GameAI.ChessCoach
{
    public sealed class EngineLine
    {
        /// <summary>Algebraic move for the first move in the line (e.g. "Nxe5").</summary>
        public string Move { get; set; }

        /// <summary>Evaluation in centipawns from the perspective of the side to move.</summary>
        public int CentipawnEval { get; set; }

        /// <summary>Full PV as algebraic notation, e.g. "8.Nxe5 Nxe5 9.dxe5 Ng4".</summary>
        public string Line { get; set; }

        /// <summary>Depth in plies or half-moves from the engine, if available.</summary>
        public int? Depth { get; set; }
    }

    public sealed class ChessEngineState
    {
        /// <summary>FEN representation of the current position.</summary>
        public string FEN { get; set; }

        /// <summary>"White" or "Black".</summary>
        public string SideToMove { get; set; }

        /// <summary>Overall evaluation in centipawns from the perspective of SideToMove.</summary>
        public int CentipawnEval { get; set; }

        /// <summary>Optional textual comment from the engine ("+0.45 slightly better for White").</summary>
        public string EvalComment { get; set; }

        /// <summary>Top engine lines in descending order of preference.</summary>
        public List<EngineLine> TopLines { get; set; } = new List<EngineLine>();

        /// <summary>Optional human-readable move history or PGN snippet.</summary>
        public string MoveHistory { get; set; }
    }
}


