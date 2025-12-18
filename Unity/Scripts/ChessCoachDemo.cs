using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach;
using GameAI.ChessCoach.Llm;
using UnityEngine;

namespace UnityIntegration.Scripts
{
    /// <summary>
    /// Example MonoBehaviour that shows how to wire ChessCoachClient into Unity.
    /// This script assumes the GameAI.ChessCoach assembly is referenced by the project.
    /// </summary>
    public class ChessCoachDemo : MonoBehaviour
    {
        private ILlmClient _llmClient;
        private ChessCoachClient _coach;

        // In a real project you might expose these as serialized fields or hook them up via a config asset.
        // Defaults are centralized in LlmDefaults so the model can be updated in one place.
        [SerializeField] private string _baseUrl = LlmDefaults.DefaultBaseUrl;
        [SerializeField] private string _model = LlmDefaults.DefaultModel;

        private void Awake()
        {
            var config = new LlmConfig(
                baseUrl: _baseUrl,
                model: _model,
                maxTokens: 4096,
                temperature: 0.6f,
                topP: 0.95f);

            _llmClient = new LlmClient(config);
            _coach = new ChessCoachClient(_llmClient);
        }

        private async void Start()
        {
            // Example engine state; in real code, populate from your engine integration.
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

            string reply = await _coach.CommentPositionAsync(state, question, CancellationToken.None);
            Debug.Log("Coach reply:\n" + reply);
        }

        private void OnDestroy()
        {
            _llmClient?.Dispose();
        }
    }
}


