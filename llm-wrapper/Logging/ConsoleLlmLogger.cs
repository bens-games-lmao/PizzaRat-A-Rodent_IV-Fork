using System;

namespace GameAI.ChessCoach.Logging
{
    /// <summary>
    /// Simple development-time logger that writes LLM requests and responses to the console.
    /// You can replace this with your own logging abstraction in a real project.
    /// </summary>
    public sealed class ConsoleLlmLogger
    {
        public bool Enabled { get; set; } = true;

        public void LogRequest(string engineStateSummary, string playerQuestion)
        {
            if (!Enabled) return;
            Console.WriteLine("[ChessCoach][Request]");
            Console.WriteLine(engineStateSummary);
            if (!string.IsNullOrWhiteSpace(playerQuestion))
            {
                Console.WriteLine("Question: " + playerQuestion);
            }
        }

        public void LogResponse(string response)
        {
            if (!Enabled) return;
            Console.WriteLine("[ChessCoach][Response]");
            Console.WriteLine(response);
        }

        public void LogError(Exception ex)
        {
            if (!Enabled) return;
            Console.WriteLine("[ChessCoach][Error] " + ex);
        }
    }
}


