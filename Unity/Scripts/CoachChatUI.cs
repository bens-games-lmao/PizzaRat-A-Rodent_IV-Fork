using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach;
using UnityEngine;
using UnityEngine.UI;

namespace UnityIntegration.Scripts
{
    /// <summary>
    /// Example UI bridge that wires CoachHarness streaming events into
    /// a simple Unity chat view with a typing indicator.
    /// </summary>
    public class CoachChatUI : MonoBehaviour
    {
        [Header("UI")]
        [SerializeField] private Text _chatText;
        [SerializeField] private GameObject _typingIndicator;

        // Optional: external code (e.g., input field handler) can call
        // RequestCoachComment with the current question string.

        private readonly ConcurrentQueue<Action> _mainThreadActions =
            new ConcurrentQueue<Action>();

        private CancellationTokenSource _currentRequestCts;

        private void Awake()
        {
            if (_typingIndicator != null)
            {
                _typingIndicator.SetActive(false);
            }
        }

        private void OnDestroy()
        {
            _currentRequestCts?.Cancel();
            _currentRequestCts?.Dispose();
            _currentRequestCts = null;
        }

        private void Update()
        {
            while (_mainThreadActions.TryDequeue(out var action))
            {
                action?.Invoke();
            }
        }

        /// <summary>
        /// Clears the chat text UI.
        /// </summary>
        public void ClearChat()
        {
            if (_chatText != null)
            {
                _chatText.text = string.Empty;
            }
        }

        /// <summary>
        /// Entry point for game code: request a streamed coach comment for
        /// the given engine state and optional player question.
        /// </summary>
        public async void RequestCoachComment(ChessEngineState state, string question)
        {
            if (state == null)
            {
                Debug.LogError("CoachChatUI.RequestCoachComment called with null state.");
                return;
            }

            var harness = CoachHarness.Instance;
            if (harness == null)
            {
                Debug.LogError("CoachHarness.Instance is null. Ensure a CoachHarness exists in the scene.");
                return;
            }

            _currentRequestCts?.Cancel();
            _currentRequestCts?.Dispose();
            _currentRequestCts = new CancellationTokenSource();
            var cancellationToken = _currentRequestCts.Token;

            void EnqueueMain(Action action)
            {
                if (action != null)
                    _mainThreadActions.Enqueue(action);
            }

            try
            {
                await harness.GenerateMoveCommentStreamingAsync(
                    character: null, // Use default coach persona; game can extend this later.
                    state: state,
                    question: question,
                    typingStarted: () => EnqueueMain(() =>
                    {
                        if (_typingIndicator != null)
                            _typingIndicator.SetActive(true);
                    }),
                    typingEnded: () => EnqueueMain(() =>
                    {
                        if (_typingIndicator != null)
                            _typingIndicator.SetActive(false);
                    }),
                    onSentence: sentence => EnqueueMain(() =>
                    {
                        if (_chatText != null && !string.IsNullOrWhiteSpace(sentence))
                        {
                            if (!string.IsNullOrEmpty(_chatText.text))
                                _chatText.text += " ";
                            _chatText.text += sentence;
                        }
                    }),
                    cancellationToken: cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Swallow expected cancellations.
            }
            catch (Exception ex)
            {
                Debug.LogError($"CoachChatUI streaming error: {ex.Message}");
                EnqueueMain(() =>
                {
                    if (_chatText != null)
                    {
                        _chatText.text +=
                            (string.IsNullOrEmpty(_chatText.text) ? "" : "\n") +
                            "[System] The coach is unavailable right now. Please try again.";
                    }
                });
            }
        }
    }
}


