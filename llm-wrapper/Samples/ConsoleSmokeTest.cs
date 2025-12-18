using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach.Llm;

namespace GameAI.ChessCoach.Samples
{
    internal static class ConsoleSmokeTest
    {
        // This is a minimal example; you can copy this into a separate console app project
        // and reference the GameAI.ChessCoach library.
        public static async Task RunAsync()
        {
            var config = new LlmConfig(
                baseUrl: LlmDefaults.DefaultBaseUrl,   // Adjust to match your running server if needed
                model: LlmDefaults.DefaultModel,
                maxTokens: LlmDefaults.DefaultMaxTokens,
                temperature: LlmDefaults.DefaultTemperature,
                topP: LlmDefaults.DefaultTopP);

            using var client = new LlmClient(config);

            var messages = new List<LlmMessage>
            {
                new LlmMessage(LlmRole.System, "You are a helpful assistant."),
                new LlmMessage(LlmRole.User, "Say hello in one short sentence, streaming.")
            };

            Console.WriteLine("Streaming LLM reply (delta chunks):");
            await client.StreamChatAsync(
                messages,
                async delta =>
                {
                    Console.Write(delta);
                    await Task.CompletedTask;
                },
                CancellationToken.None);

            Console.WriteLine();
        }
    }
}


