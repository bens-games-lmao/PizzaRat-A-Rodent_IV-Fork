using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach.Llm;

namespace GameAI.ChessCoach
{
    public static class ChessCoachClientBuild
    {
        public static string BuildDefaultSystemPrompt()
        {
            var sb = new StringBuilder();
            sb.AppendLine("You are a narration layer over a chess engine, not a chess engine yourself.");


            return sb.ToString();
        }

        public static string BuildUserContent(ChessEngineState state, string playerQuestion)
        {
            var sb = new StringBuilder();

            sb.AppendLine("Here is the current game state and engine analysis:");
            sb.AppendLine();
            sb.AppendLine(SerializeEngineState(state));

            sb.AppendLine();
            if (!string.IsNullOrWhiteSpace(playerQuestion))
            {
                sb.AppendLine("Player question:");
                sb.AppendLine(playerQuestion.Trim());
            }
            else
            {
                sb.AppendLine("Explain, in plain language, what the ENGINE_STATE block says.");
                sb.AppendLine("Describe the evaluation, game status, and the engine's top lines, and summarize the typical plans they suggest.");
                sb.AppendLine("Do not invent any new moves, evaluations, or piece locations beyond what ENGINE_STATE already contains.");
            }

            return sb.ToString();
        }

        public static string SerializeEngineState(ChessEngineState state)
        {
            var sb = new StringBuilder();
            sb.AppendLine("[ENGINE_STATE]");
            sb.AppendLine("Side to move: " + state.SideToMove);
            sb.AppendLine("Current FEN: " + state.FEN);
            sb.AppendLine("Evaluation (centipawns for side to move): " + state.CentipawnEval);

            if (!string.IsNullOrWhiteSpace(state.EvalComment))
                sb.AppendLine("Evaluation comment: " + state.EvalComment.Trim());

            if (!string.IsNullOrWhiteSpace(state.MoveHistory))
            {
                sb.AppendLine();
                sb.AppendLine("Recent moves:");
                sb.AppendLine(state.MoveHistory.Trim());
            }

            if (state.TopLines != null && state.TopLines.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("Top lines:");
                for (int i = 0; i < state.TopLines.Count; i++)
                {
                    var line = state.TopLines[i];
                    sb.AppendLine(
                        $"{i + 1}) Move: {line.Move}, Eval: {line.CentipawnEval / 100.0:+0.00;-0.00;0.00}, Line: {line.Line}" 
                        + (line.Depth.HasValue ? $" (depth {line.Depth})" : string.Empty)
                    );
                }
            }

            sb.AppendLine("[END_ENGINE_STATE]");
            return sb.ToString();
        }
    }

    public sealed class ChessCoachClient
    {
        private readonly ILlmClient _llmClient;
        private readonly string _systemPrompt;

        /// <summary>
        /// Raised once per reply when the first streaming delta arrives.
        /// UI should show the "...typing" indicator.
        /// </summary>
        public event Action TypingStarted;

        /// <summary>
        /// Raised when streaming for this reply fully ends (success or failure).
        /// UI should hide the "...typing" indicator.
        /// </summary>
        public event Action TypingEnded;

        /// <summary>
        /// Raised whenever a full sentence has been completed while streaming.
        /// UI should append this sentence to the chat view.
        /// </summary>
        public event Action<string> SentenceReady;

        public ChessCoachClient(ILlmClient llmClient, string customSystemPrompt = null)
        {
            _llmClient = llmClient ?? throw new ArgumentNullException(nameof(llmClient));
            _systemPrompt = string.IsNullOrWhiteSpace(customSystemPrompt)
                ? ChessCoachClientBuild.BuildDefaultSystemPrompt()
                : customSystemPrompt;
        }

        public async Task<string> CommentPositionAsync(
            ChessEngineState engineState,
            string playerQuestion,
            CancellationToken cancellationToken = default)
        {
            var messages = BuildMessages(engineState, playerQuestion);

            return await _llmClient.CompleteChatAsync(messages, cancellationToken)
                                   .ConfigureAwait(false);
        }

        /// <summary>
        /// Streams a coaching reply. Buffers text until full sentences
        /// are available, then raises SentenceReady per sentence.
        /// </summary>
        /// <remarks>
        /// Events are raised on a background thread performing HTTP streaming.
        /// Unity UI code must marshal handlers back to the main thread.
        /// </remarks>
        public async Task GenerateCommentStreamingAsync(
            ChessEngineState engineState,
            string playerQuestion,
            CancellationToken cancellationToken = default)
        {
            var messages = BuildMessages(engineState, playerQuestion);

            var sentenceBuffer = new StringBuilder();
            var firstDeltaSeen = false;

            void FlushSentenceIfAny()
            {
                if (sentenceBuffer.Length == 0)
                    return;

                string sentence = sentenceBuffer.ToString().Trim();
                if (sentence.Length == 0)
                {
                    sentenceBuffer.Clear();
                    return;
                }

                SentenceReady?.Invoke(sentence);
                sentenceBuffer.Clear();
            }

            try
            {
                await _llmClient.StreamChatAsync(
                    messages,
                    async delta =>
                    {
                        if (cancellationToken.IsCancellationRequested)
                            return;

                        if (!firstDeltaSeen)
                        {
                            firstDeltaSeen = true;
                            TypingStarted?.Invoke();
                        }

                        foreach (char ch in delta)
                        {
                            sentenceBuffer.Append(ch);

                            if (IsSentenceTerminator(ch))
                            {
                                FlushSentenceIfAny();
                            }
                        }

                        await Task.CompletedTask;
                    },
                    cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                if (!cancellationToken.IsCancellationRequested)
                {
                    sentenceBuffer.Replace("\n", " ").Replace("\r", " ");
                    if (sentenceBuffer.Length > 0)
                    {
                        SentenceReady?.Invoke(sentenceBuffer.ToString().Trim());
                        sentenceBuffer.Clear();
                    }
                }

                TypingEnded?.Invoke();
            }
        }

        private static bool IsSentenceTerminator(char ch)
        {
            return ch == '.' || ch == '!' || ch == '?';
        }

        private List<LlmMessage> BuildMessages(
            ChessEngineState engineState,
            string playerQuestion)
        {
            if (engineState == null)
                throw new ArgumentNullException(nameof(engineState));

            var messages = new List<LlmMessage>
            {
                new LlmMessage(LlmRole.System, _systemPrompt),
                new LlmMessage(LlmRole.User, ChessCoachClientBuild.BuildUserContent(engineState, playerQuestion))
            };

            return messages;
        }
    }
}
