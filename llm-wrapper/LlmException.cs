using System;

namespace GameAI.ChessCoach.Llm
{
    public sealed class LlmException : Exception
    {
        public int? StatusCode { get; }
        public string RawResponse { get; }

        public LlmException(string message, int? statusCode = null, string rawResponse = null)
            : base(message)
        {
            StatusCode = statusCode;
            RawResponse = rawResponse;
        }
    }
}


