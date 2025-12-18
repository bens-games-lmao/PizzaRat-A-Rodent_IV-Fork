using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach;
using GameAI.ChessCoach.Characters;
using UnityEngine;

namespace UnityIntegration.Scripts
{
    /// <summary>
    /// High-level safety and persona harness for the chess coach.
    /// All game code should call this instead of talking directly to ChessCoachClient.
    /// </summary>
    public class CoachHarness : MonoBehaviour
    {
        public static CoachHarness Instance { get; private set; }

        [Header("Behavior")]
        [SerializeField] private bool _useConversation = false;

        [Header("Safety")]
        [SerializeField] private int _maxChars = 1000;
        [SerializeField] private string[] _bannedPhrases;

        private ChessConversation _conversation;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }

            Instance = this;
            DontDestroyOnLoad(gameObject);
        }

        /// <summary>
        /// Main entry point: get a safe, persona-aware comment for the given position.
        /// </summary>
        public async Task<string> GetMoveCommentAsync(
            CharacterProfile character,
            ChessEngineState state,
            string question,
            CancellationToken cancellationToken)
        {
            if (state == null)
                throw new ArgumentNullException(nameof(state));

            var llmService = CoachLlmService.Instance;
            if (llmService == null || llmService.LlmClient == null)
                throw new InvalidOperationException("CoachLlmService is not initialized.");

            string systemPrompt = BuildFullSystemPrompt(character);

            string raw;

            if (_useConversation)
            {
                _conversation ??= new ChessConversation(llmService.LlmClient, systemPrompt);
                raw = await _conversation.CommentPositionAsync(state, question, cancellationToken)
                                         .ConfigureAwait(false);
            }
            else
            {
                var coach = new ChessCoachClient(llmService.LlmClient, systemPrompt);
                raw = await coach.CommentPositionAsync(state, question, cancellationToken)
                                 .ConfigureAwait(false);
            }

            return SanitizeReply(raw);
        }

        private static string BuildHarnessBasePrompt()
        {
            var sb = new StringBuilder();
            sb.AppendLine("You are an in-game chess coach for a chess video game.");
            sb.AppendLine("You MUST only talk about chess positions and moves given in the ENGINE_STATE block.");
            sb.AppendLine("You must not discuss real-world topics, politics, religion, or other sensitive content.");
            sb.AppendLine("You must always use PG-13 language and avoid profanity, slurs, or explicit content.");
            sb.AppendLine("If the player asks about anything non-chess, politely refuse and steer the discussion back to chess.");
            sb.AppendLine();
            return sb.ToString();
        }

        private static string BuildFullSystemPrompt(CharacterProfile character)
        {
            var sb = new StringBuilder();
            sb.Append(BuildHarnessBasePrompt());

            string persona = PersonaPromptBuilder.BuildPersonaPrompt(character);
            if (!string.IsNullOrWhiteSpace(persona))
            {
                sb.AppendLine(persona);
            }

            sb.AppendLine(ChessCoachClientBuild.BuildDefaultSystemPrompt());
            return sb.ToString();
        }

        private string SanitizeReply(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
                return "The coach has no useful comment for this position.";

            string text = raw.Trim();

            if (_maxChars > 0 && text.Length > _maxChars)
            {
                text = text.Substring(0, _maxChars) + " …";
            }

            if (_bannedPhrases != null && _bannedPhrases.Length > 0)
            {
                string lower = text.ToLowerInvariant();
                foreach (var phrase in _bannedPhrases)
                {
                    if (string.IsNullOrWhiteSpace(phrase)) continue;
                    if (lower.Contains(phrase.ToLowerInvariant()))
                    {
                        return "The coach's answer was not appropriate. Here is a neutral suggestion: focus on your king safety, piece activity, and obvious tactical threats.";
                    }
                }
            }

            return text;
        }

        /// <summary>
        /// Streaming entry point: generates a persona-aware comment with
        /// sentence-level buffering and typing callbacks.
        /// </summary>
        /// <remarks>
        /// The callbacks are invoked on a background thread performing HTTP streaming.
        /// Callers (e.g., Unity UI) must marshal to the main thread before touching Unity APIs.
        /// This path currently does not apply the post-hoc SanitizeReply filter; instead,
        /// safety is enforced via the system prompt built in BuildFullSystemPrompt.
        /// </remarks>
        public async Task GenerateMoveCommentStreamingAsync(
            CharacterProfile character,
            ChessEngineState state,
            string question,
            Action typingStarted,
            Action typingEnded,
            Action<string> onSentence,
            CancellationToken cancellationToken)
        {
            if (state == null)
                throw new ArgumentNullException(nameof(state));

            var llmService = CoachLlmService.Instance;
            if (llmService == null || llmService.LlmClient == null)
                throw new InvalidOperationException("CoachLlmService is not initialized.");

            string systemPrompt = BuildFullSystemPrompt(character);
            var coach = new ChessCoachClient(llmService.LlmClient, systemPrompt);

            void OnTypingStarted() => typingStarted?.Invoke();
            void OnTypingEnded() => typingEnded?.Invoke();
            void OnSentenceReady(string sentence) => onSentence?.Invoke(sentence);

            coach.TypingStarted += OnTypingStarted;
            coach.TypingEnded += OnTypingEnded;
            coach.SentenceReady += OnSentenceReady;

            try
            {
                await coach.GenerateCommentStreamingAsync(
                    state,
                    question,
                    cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                coach.TypingStarted -= OnTypingStarted;
                coach.TypingEnded -= OnTypingEnded;
                coach.SentenceReady -= OnSentenceReady;
            }
        }

        private void OnDestroy()
        {
            if (Instance == this)
            {
                Instance = null;
            }
        }
    }
}


