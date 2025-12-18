using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach;
using GameAI.ChessCoach.Llm;
using UnityEngine;

namespace UnityIntegration.Scripts
{
    /// <summary>
    /// Central service that owns the LlmClient configuration and lifecycle.
    /// Attach this to a GameObject in your bootstrap scene and it will persist.
    /// Other scripts can access the shared ILlmClient via CoachLlmService.Instance.
    /// </summary>
    public class CoachLlmService : MonoBehaviour
    {
        public static CoachLlmService Instance { get; private set; }

        [Header("LLM connection")]
        [SerializeField] private string _baseUrl = LlmDefaults.DefaultBaseUrl;
        [SerializeField] private string _model = LlmDefaults.DefaultModel;

        [Header("Sampling")]
        [SerializeField] private int _maxTokens = LlmDefaults.DefaultMaxTokens;
        [SerializeField] private float _temperature = LlmDefaults.DefaultTemperature;
        [SerializeField] private float _topP = LlmDefaults.DefaultTopP;

        private ILlmClient _llmClient;

        /// <summary>
        /// Shared ILlmClient instance. Do not dispose this yourself; the service manages it.
        /// </summary>
        public ILlmClient LlmClient => _llmClient;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }

            Instance = this;
            DontDestroyOnLoad(gameObject);

            var config = new LlmConfig(
                baseUrl: _baseUrl,
                model: _model,
                maxTokens: _maxTokens,
                temperature: _temperature,
                topP: _topP);

            _llmClient = new LlmClient(config);
        }

        /// <summary>
        /// Very low-level helper that calls the default ChessCoachClient with
        /// the standard coach system prompt. In most cases you should use the
        /// higher-level CoachHarness instead, which adds safety and persona control.
        /// </summary>
        public async Task<string> RawChatAsync(
            ChessEngineState state,
            string question,
            CancellationToken cancellationToken)
        {
            if (state == null)
                throw new System.ArgumentNullException(nameof(state));

            var coach = new ChessCoachClient(_llmClient);
            return await coach.CommentPositionAsync(state, question, cancellationToken)
                              .ConfigureAwait(false);
        }

        private void OnDestroy()
        {
            if (Instance == this)
            {
                Instance = null;
            }

            _llmClient?.Dispose();
            _llmClient = null;
        }
    }
}


