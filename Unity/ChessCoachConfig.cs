using GameAI.ChessCoach.Llm;

namespace UnityIntegration
{
    /// <summary>
    /// Simple holder for LLM configuration values. In a real Unity project,
    /// you would likely replace this with a ScriptableObject or project settings.
    /// Defaults are centralized in <see cref="LlmDefaults"/>.
    /// </summary>
    public sealed class ChessCoachConfig
    {
        public string BaseUrl { get; set; } = LlmDefaults.DefaultBaseUrl;
        public string Model { get; set; } = LlmDefaults.DefaultModel;
        public int MaxTokens { get; set; } = LlmDefaults.DefaultMaxTokens;
        public float Temperature { get; set; } = LlmDefaults.DefaultTemperature;
        public float TopP { get; set; } = LlmDefaults.DefaultTopP;

        public LlmConfig ToLlmConfig()
        {
            return new LlmConfig(
                baseUrl: BaseUrl,
                model: Model,
                maxTokens: MaxTokens,
                temperature: Temperature,
                topP: TopP);
        }
    }
}


