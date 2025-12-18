using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach.Llm;

namespace GameAI.ChessCoach
{
    /// <summary>
    /// Optional helper that keeps conversation history between the player and the coach.
    /// This wraps ILlmClient directly so multiple turns can build on each other.
    /// </summary>
    public sealed class ChessConversation
    {
        private readonly ILlmClient _llmClient;
        private readonly string _systemPrompt;
        private readonly List<LlmMessage> _history;

        public ChessConversation(ILlmClient llmClient, string customSystemPrompt = null)
        {
            _llmClient = llmClient ?? throw new ArgumentNullException(nameof(llmClient));
            _systemPrompt = string.IsNullOrWhiteSpace(customSystemPrompt)
                ? ChessCoachClientSystemPrompt.Default
                : customSystemPrompt;

            _history = new List<LlmMessage>
            {
                new LlmMessage(LlmRole.System, _systemPrompt)
            };
        }

        public IReadOnlyList<LlmMessage> History => _history.AsReadOnly();

        public async Task<string> CommentPositionAsync(
            ChessEngineState engineState,
            string playerQuestion,
            CancellationToken cancellationToken = default)
        {
            if (engineState == null)
                throw new ArgumentNullException(nameof(engineState));

            var userContent = ChessCoachClientSystemPrompt.BuildUserContent(engineState, playerQuestion);
            var userMessage = new LlmMessage(LlmRole.User, userContent);

            _history.Add(userMessage);

            string reply = await _llmClient.CompleteChatAsync(_history, cancellationToken)
                                           .ConfigureAwait(false);

            _history.Add(new LlmMessage(LlmRole.Assistant, reply ?? string.Empty));

            return reply;
        }
    }

    /// <summary>
    /// Helper exposing the default system prompt and user-content builder
    /// so they can be reused by ChessConversation and external callers.
    /// </summary>
    public static class ChessCoachClientSystemPrompt
    {
        public static string Default => ChessCoachClientBuild.BuildDefaultSystemPrompt();

        public static string BuildUserContent(ChessEngineState state, string playerQuestion)
            => ChessCoachClientBuild.BuildUserContent(state, playerQuestion);
    }
}


