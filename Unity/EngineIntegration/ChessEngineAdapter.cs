using GameAI.ChessCoach;

namespace UnityIntegration.EngineIntegration
{
    /// <summary>
    /// Example adapter that turns generic engine outputs into a ChessEngineState.
    /// In a real project you would call this from your Stockfish/Rodent wrapper.
    /// </summary>
    public static class ChessEngineAdapter
    {
        public static ChessEngineState CreateState(
            string fen,
            string sideToMove,
            int centipawnEval,
            string evalComment,
            string moveHistory)
        {
            return new ChessEngineState
            {
                FEN = fen,
                SideToMove = sideToMove,
                CentipawnEval = centipawnEval,
                EvalComment = evalComment,
                MoveHistory = moveHistory
            };
        }
    }
}


