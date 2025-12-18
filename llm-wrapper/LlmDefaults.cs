using GameAI.ChessCoach.Llm;

namespace GameAI.ChessCoach.Llm
{
    /// <summary>
    /// Centralized defaults for connecting to the local LLM server.
    /// Update these values to change the default model or sampling
    /// parameters across all samples and Unity integration code.
    /// </summary>
    public static class LlmDefaults
    {
        public const string DefaultBaseUrl = "http://127.0.0.1:1234";
        public const string DefaultModel = "smollm3-3b-128k";
        public const int DefaultMaxTokens = 4096;
        public const float DefaultTemperature = 0.6f;
        public const float DefaultTopP = 0.95f;
    }
}

