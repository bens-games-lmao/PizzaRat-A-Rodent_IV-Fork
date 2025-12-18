using System;
using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach;
using GameAI.ChessCoach.Llm;

namespace GameAI.ChessCoach.Samples
{
    internal static class ChessCoachSample
    {
        // This is a non-Unity sample showing how to construct a ChessEngineState
        // and call ChessCoachClient. You can adapt this into tests or a console app.
        public static async Task RunAsync()
        {
            var config = new LlmConfig(
                baseUrl: LlmDefaults.DefaultBaseUrl,   // Adjust to match your running server if needed
                model: LlmDefaults.DefaultModel,
                maxTokens: LlmDefaults.DefaultMaxTokens,
                temperature: LlmDefaults.DefaultTemperature,
                topP: LlmDefaults.DefaultTopP);

            using var llmClient = new LlmClient(config);
            var coach = new ChessCoachClient(llmClient);

            var state = new ChessEngineState
            {
                FEN = "r1bq1rk1/ppp2ppp/2n2n2/3pp3/3P4/2P1PN2/PP1N1PPP/R1BQ1RK1 w - - 0 8",
                SideToMove = "White",
                CentipawnEval = 45,
                EvalComment = "+0.45 (slightly better for White)",
                MoveHistory = "1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 ..."
            };

            state.TopLines.Add(new EngineLine
            {
                Move = "dxe5",
                CentipawnEval = 60,
                Line = "8.dxe5 Ng4 9.e4 dxe4 10.Nxe4",
                Depth = 22
            });

            state.TopLines.Add(new EngineLine
            {
                Move = "Nxe5",
                CentipawnEval = 20,
                Line = "8.Nxe5 Nxe5 9.dxe5 Ng4",
                Depth = 23
            });

            string question = "I'm considering Nxe5. How risky is it compared to dxe5?";

            Console.WriteLine("Streaming coach reply (sentence by sentence):");

            void OnSentence(string sentence)
            {
                Console.WriteLine(sentence);
            }

            coach.SentenceReady += OnSentence;

            try
            {
                await coach.GenerateCommentStreamingAsync(state, question, CancellationToken.None);
            }
            finally
            {
                coach.SentenceReady -= OnSentence;
            }
        }
    }
}


