using System;

namespace GameAI.ChessCoach.Llm
{
    public sealed class LlmConfig
    {
        public string BaseUrl { get; }
        public string Model { get; }
        public int MaxTokens { get; }
        public float Temperature { get; }
        public float TopP { get; }
        public string[] StopSequences { get; }

        public LlmConfig(
            string baseUrl,
            string model,
            int maxTokens = 4096,
            float temperature = 0.6f,
            float topP = 0.95f,
            string[] stopSequences = null)
        {
            if (string.IsNullOrWhiteSpace(baseUrl))
                throw new ArgumentException("BaseUrl cannot be null or empty.", nameof(baseUrl));
            if (string.IsNullOrWhiteSpace(model))
                throw new ArgumentException("Model cannot be null or empty.", nameof(model));

            BaseUrl = baseUrl.TrimEnd('/');
            Model = model;
            MaxTokens = maxTokens;
            Temperature = temperature;
            TopP = topP;
            StopSequences = stopSequences ?? Array.Empty<string>();
        }
    }

    public enum LlmRole
    {
        System,
        User,
        Assistant
    }

    public sealed class LlmMessage
    {
        public LlmRole Role { get; }
        public string Content { get; }

        public LlmMessage(LlmRole role, string content)
        {
            Role = role;
            Content = content ?? string.Empty;
        }

        internal string ToWireRole()
        {
            switch (Role)
            {
                case LlmRole.System: return "system";
                case LlmRole.User: return "user";
                case LlmRole.Assistant: return "assistant";
                default: return "user";
            }
        }
    }
}


