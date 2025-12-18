Chess LLM Wrapper – Technical Design (SmolLM3-3B, ≤6GB VRAM)
0. Context

Model: HuggingFaceTB/SmolLM3-3B (instruct/reasoning checkpoint).

Quantization: GGUF Q4_K_M or similar, via llama.cpp / compatible stack (e.g. unsloth/SmolLM3-3B-GGUF).

Usage: Not a chess engine. Stockfish (or another engine) supplies evals and candidate lines; the LLM explains and chats about them.

Goal: Provide a small, well-defined C# API the Unity game can call to get “coach-style” comments about positions and moves.

1. High-Level Architecture
1.1 Components

LLM Inference Server (runs locally, out-of-process)

Implementation: llama.cpp (or similar) exposing OpenAI-compatible /v1/chat/completions endpoint.

Model: smollm3-3b GGUF, started with the proper chat-template support.

C# Library (this wrapper)
Namespace suggestion: GameAI.ChessCoach

Contains:

LlmConfig, LlmMessage, ILlmClient, LlmClient

Chess-specific layer: ChessEngineState, EngineLine, ChessCoachClient

Game / Unity Client

Already talks to Stockfish (or equivalent).

Passes ChessEngineState + optional user question → ChessCoachClient → gets back a string response and displays it.

1.2 Data Flow (runtime)

Game updates position and queries Stockfish.

Game builds a ChessEngineState object from Stockfish output.

Game calls ChessCoachClient.CommentPositionAsync(engineState, question).

ChessCoachClient:

Builds messages: system + user (with serialized engine state + question).

Calls ILlmClient.CompleteChatAsync(messages).

LLM server returns chat completion; wrapper returns the content string to the game.

2. LLM Server Requirements

The wrapper assumes an OpenAI-like chat API:

Base URL example: http://127.0.0.1:8080/v1
// REAL URL ENDPOINT: http://127.0.0.1:1234

/* EXAMPLE HTTP REQUEST FORMAT
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "smollm3-3b",
    "messages": [
        {
            "role": "system",
            "content": "Always answer in rhymes. Today is Thursday"
        },
        {
            "role": "user",
            "content": "What day is it today?"
        }
    ],
    "temperature": 0.7,
    "max_tokens": -1,
    "stream": false
}'

*/
Endpoint: POST /chat/completions

Request body (simplified):

{
  "model": "smollm3-3b",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 4096,
  "temperature": 0.6,
  "top_p": 0.95
}


llama.cpp already supports an OpenAI-compatible API when started with --api-openai; GGUFs for SmolLM3 include chat-template fixes specifically for llama.cpp.

The C# dev doesn’t need to implement the LLM itself, just call this HTTP API.

3. Core LLM Wrapper
3.1 Public Configuration & Message Types
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


Target framework: .NET Standard 2.0, so this builds as a regular class library that Unity can reference.

3.2 Interface & Default HTTP Implementation
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace GameAI.ChessCoach.Llm
{
    public interface ILlmClient : IDisposable
    {
        Task<string> CompleteChatAsync(
            IList<LlmMessage> messages,
            CancellationToken cancellationToken = default);
    }

    public sealed class LlmClient : ILlmClient
    {
        private readonly LlmConfig _config;
        private readonly HttpClient _httpClient;
        private bool _disposed;

        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true
        };

        public LlmClient(LlmConfig config, HttpClient httpClient = null)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            _httpClient = httpClient ?? new HttpClient();
        }

        public async Task<string> CompleteChatAsync(
            IList<LlmMessage> messages,
            CancellationToken cancellationToken = default)
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(LlmClient));

            if (messages == null || messages.Count == 0)
                throw new ArgumentException("Messages must not be empty.", nameof(messages));

            var wireMessages = new List<MessageDto>(messages.Count);
            foreach (var msg in messages)
            {
                wireMessages.Add(new MessageDto
                {
                    role = msg.ToWireRole(),
                    content = msg.Content
                });
            }

            var requestDto = new ChatRequestDto
            {
                model = _config.Model,
                messages = wireMessages,
                max_tokens = _config.MaxTokens,
                temperature = _config.Temperature,
                top_p = _config.TopP,
                stop = _config.StopSequences.Length > 0 ? _config.StopSequences : null
            };

            string json = JsonSerializer.Serialize(requestDto, JsonOptions);
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            var uri = new Uri(_config.BaseUrl + "/chat/completions");

            using (var response = await _httpClient.PostAsync(uri, content, cancellationToken)
                                                  .ConfigureAwait(false))
            {
                string responseJson = await response.Content.ReadAsStringAsync().ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    throw new LlmException(
                        "LLM server returned non-success status.",
                        (int)response.StatusCode,
                        responseJson);
                }

                var responseDto = JsonSerializer.Deserialize<ChatResponseDto>(responseJson, JsonOptions)
                                  ?? throw new LlmException("LLM server returned an invalid response.");

                if (responseDto.choices == null ||
                    responseDto.choices.Length == 0 ||
                    responseDto.choices[0].message == null)
                {
                    throw new LlmException("LLM server returned an empty choices array.");
                }

                return responseDto.choices[0].message.content ?? string.Empty;
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _httpClient?.Dispose();
        }

        #region DTOs

        private sealed class ChatRequestDto
        {
            public string model { get; set; }
            public List<MessageDto> messages { get; set; }
            public int max_tokens { get; set; }
            public float temperature { get; set; }
            public float top_p { get; set; }
            public string[] stop { get; set; }
        }

        private sealed class MessageDto
        {
            public string role { get; set; }
            public string content { get; set; }
        }

        private sealed class ChatResponseDto
        {
            public ChoiceDto[] choices { get; set; }
        }

        private sealed class ChoiceDto
        {
            public MessageDto message { get; set; }
        }

        #endregion
    }

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


This is generic: it will work with SmolLM3-3B now, but could be swapped to any OpenAI-style local model later.

4. Chess-Specific Layer
4.1 Data Models

These sit above ILlmClient and are what your engine/Unity code passes.

namespace GameAI.ChessCoach
{
    public sealed class EngineLine
    {
        /// <summary>Algebraic move for the first move in the line (e.g. "Nxe5").</summary>
        public string Move { get; set; }

        /// <summary>Evaluation in centipawns from the perspective of the side to move.</summary>
        public int CentipawnEval { get; set; }

        /// <summary>Full PV as algebraic notation, e.g. "8.Nxe5 Nxe5 9.dxe5 Ng4".</summary>
        public string Line { get; set; }

        /// <summary>Depth in plies or half-moves from the engine, if available.</summary>
        public int? Depth { get; set; }
    }

    public sealed class ChessEngineState
    {
        /// <summary>FEN representation of the current position.</summary>
        public string FEN { get; set; }

        /// <summary>"White" or "Black".</summary>
        public string SideToMove { get; set; }

        /// <summary>Overall evaluation in centipawns from the perspective of SideToMove.</summary>
        public int CentipawnEval { get; set; }

        /// <summary>Optional textual comment from the engine ("+0.45 slightly better for White").</summary>
        public string EvalComment { get; set; }

        /// <summary>Top engine lines in descending order of preference.</summary>
        public List<EngineLine> TopLines { get; set; } = new List<EngineLine>();

        /// <summary>Optional human-readable move history or PGN snippet.</summary>
        public string MoveHistory { get; set; }
    }
}

4.2 ChessCoachClient API
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using GameAI.ChessCoach.Llm;

namespace GameAI.ChessCoach
{
    public sealed class ChessCoachClient
    {
        private readonly ILlmClient _llmClient;
        private readonly string _systemPrompt;

        public ChessCoachClient(ILlmClient llmClient, string customSystemPrompt = null)
        {
            _llmClient = llmClient ?? throw new ArgumentNullException(nameof(llmClient));
            _systemPrompt = string.IsNullOrWhiteSpace(customSystemPrompt)
                ? BuildDefaultSystemPrompt()
                : customSystemPrompt;
        }

        public async Task<string> CommentPositionAsync(
            ChessEngineState engineState,
            string playerQuestion,
            CancellationToken cancellationToken = default)
        {
            if (engineState == null)
                throw new ArgumentNullException(nameof(engineState));

            var messages = new List<LlmMessage>
            {
                new LlmMessage(LlmRole.System, _systemPrompt),
                new LlmMessage(LlmRole.User, BuildUserContent(engineState, playerQuestion))
            };

            return await _llmClient.CompleteChatAsync(messages, cancellationToken)
                                   .ConfigureAwait(false);
        }

        private static string BuildDefaultSystemPrompt()
        {
            var sb = new StringBuilder();
            sb.AppendLine("You are a strong chess coach (~2200 Elo) commentating a live game.");
            sb.AppendLine("You NEVER invent engine evaluations or moves.");
            sb.AppendLine("You only explain and discuss what is contained in the ENGINE_STATE block.");
            sb.AppendLine("Use algebraic notation and keep responses concise and concrete.");
            sb.AppendLine("Focus on plans, key squares, and tactical ideas, not only moves.");
            sb.AppendLine();
            return sb.ToString();
        }

        private static string BuildUserContent(ChessEngineState state, string playerQuestion)
        {
            var sb = new StringBuilder();

            sb.AppendLine("Here is the current game state and engine analysis:");
            sb.AppendLine();
            sb.AppendLine(SerializeEngineState(state));

            sb.AppendLine();
            if (!string.IsNullOrWhiteSpace(playerQuestion))
            {
                sb.AppendLine("Player question:");
                sb.AppendLine(playerQuestion.Trim());
            }
            else
            {
                sb.AppendLine("Explain the evaluation, the main plan for the side to move,");
                sb.AppendLine("and briefly compare the top engine moves mentioned in ENGINE_STATE.");
            }

            return sb.ToString();
        }

        private static string SerializeEngineState(ChessEngineState state)
        {
            var sb = new StringBuilder();
            sb.AppendLine("[ENGINE_STATE]");
            sb.AppendLine("Side to move: " + state.SideToMove);
            sb.AppendLine("Current FEN: " + state.FEN);
            sb.AppendLine("Evaluation (centipawns for side to move): " + state.CentipawnEval);

            if (!string.IsNullOrWhiteSpace(state.EvalComment))
                sb.AppendLine("Evaluation comment: " + state.EvalComment.Trim());

            if (!string.IsNullOrWhiteSpace(state.MoveHistory))
            {
                sb.AppendLine();
                sb.AppendLine("Recent moves:");
                sb.AppendLine(state.MoveHistory.Trim());
            }

            if (state.TopLines != null && state.TopLines.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("Top lines:");
                for (int i = 0; i < state.TopLines.Count; i++)
                {
                    var line = state.TopLines[i];
                    sb.AppendLine(
                        $"{i + 1}) Move: {line.Move}, Eval: {line.CentipawnEval / 100.0:+0.00;-0.00;0.00}, Line: {line.Line}"
                        + (line.Depth.HasValue ? $" (depth {line.Depth})" : string.Empty)
                    );
                }
            }

            sb.AppendLine("[END_ENGINE_STATE]");
            return sb.ToString();
        }
    }
}


This is the core “call one method and get a chess explanation” interface:

Task<string> CommentPositionAsync(ChessEngineState engineState, string playerQuestion, CancellationToken ct = default);

5. Prompting Strategy for SmolLM3-3B

SmolLM3 supports dual-mode reasoning: /think for explicit chain-of-thought and /no_think for direct answers; this is wired into its chat template and documented in HF’s blog & tutorials.

For this use-case, we let the model use its default reasoning behavior and do not force either mode in the system prompt. The server and web UI are responsible for stripping any `<think>...</think>` spans from the visible answer while still making them available in dev tooling.

If you need to force shorter, more direct answers, you can optionally add `Reasoning mode: /no_think` to the system or user prompt and then post-process out any “thinking” span on the client side if needed.

Example messages actually sent over the wire:

System:

You are a strong chess coach (~2200 Elo) commentating a live game.
You NEVER invent engine evaluations or moves.
You only explain and discuss what is contained in the ENGINE_STATE block.
Use algebraic notation and keep responses concise and concrete.
Focus on plans, key squares, and tactical ideas, not only moves.


User:

Here is the current game state and engine analysis:

[ENGINE_STATE]
Side to move: White
Current FEN: r1bq1rk1/ppp2ppp/2n2n2/3pp3/3P4/2P1PN2/PP1N1PPP/R1BQ1RK1 w - - 0 8
Evaluation (centipawns for side to move): 45
Evaluation comment: +0.45 (slightly better for White)

Recent moves:
1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 ...

Top lines:
1) Move: dxe5, Eval: +0.60, Line: 8.dxe5 Ng4 9.e4 dxe4 10.Nxe4 (depth 22)
2) Move: Nxe5, Eval: +0.20, Line: 8.Nxe5 Nxe5 9.dxe5 Ng4 (depth 23)
3) Move: dxc5, Eval: +0.15, Line: 8.dxc5 Re8 9.b4 (depth 21)
[END_ENGINE_STATE]

Player question:
I'm thinking about playing Nxe5. Is that a bad idea? What is the plan if I follow the top engine move instead?


SmolLM’s chat template is handled by the tokenizer/llama.cpp conversion; the C# side just sends messages like this via the OpenAI-style API.

6. Unity Integration Example
6.1 MonoBehaviour Example
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using GameAI.ChessCoach;
using GameAI.ChessCoach.Llm;

public class ChessCoachDemo : MonoBehaviour
{
    private ILlmClient _llmClient;
    private ChessCoachClient _coach;

    private void Awake()
    {
        var config = new LlmConfig(
            baseUrl: "http://127.0.0.1:8080/v1",   // LLM server base URL
            model: "smollm3-3b",          // Model id as configured on the server
            maxTokens: 4096,
            temperature: 0.6f,
            topP: 0.95f);

        _llmClient = new LlmClient(config);
        _coach = new ChessCoachClient(_llmClient);
    }

    private async void Start()
    {
        // Example engine state; in real code, populate from Stockfish integration.
        var state = new ChessEngineState
        {
            FEN = "r1bq1rk1/ppp2ppp/2n2n2/3pp3/3P4/2P1PN2/PP1N1PPP/R1BQ1RK1 w - - 0 8",
            SideToMove = "White",
            CentipawnEval = 45,
            EvalComment = "+0.45 (slightly better for White)",
            MoveHistory = "1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 ..."
        };

        state.TopLines.Add(new EngineLine
        {
            Move = "dxe5",
            CentipawnEval = 60,
            Line = "8.dxe5 Ng4 9.e4 dxe4 10.Nxe4",
            Depth = 22
        });

        state.TopLines.Add(new EngineLine
        {
            Move = "Nxe5",
            CentipawnEval = 20,
            Line = "8.Nxe5 Nxe5 9.dxe5 Ng4",
            Depth = 23
        });

        string question = "I'm considering Nxe5. How risky is it compared to dxe5?";

        string reply = await _coach.CommentPositionAsync(state, question, CancellationToken.None);
        Debug.Log("Coach reply:\n" + reply);
    }

    private void OnDestroy()
    {
        _llmClient?.Dispose();
    }
}

7. Config & Operational Concerns
7.1 Model selection & VRAM

Default: smollm3-3b GGUF (≈2 GB file; tuned for low-VRAM inference).

Alternates: you can test Q4_0, Q5_K_M, etc. The C# wrapper doesn’t change; just update:

the file used by the LLM server, and

LlmConfig.Model to match whatever that server expects.

7.2 Performance knobs

Exposed via LlmConfig (caller decides):

MaxTokens: typical range 128–512 for short chess comments.

Temperature: lower (0.4–0.7) for more deterministic, “coach-like” tone.

TopP: 0.9–0.95 is standard; can be lowered for even more determinism.

7.3 Error handling

LlmException should be caught by Unity layer.

On error, return a safe fallback string to the user (e.g., “The coach is thinking too hard—try again in a moment”) while logging the raw response for debugging.

8. Optional Future Extensions (for the dev to keep in mind)

These are not required now but the design should make them easy:

Conversation history

Wrap ChessCoachClient in a ChessConversation that stores previous LlmMessages and appends new user/assistant turns for more “human-like” sessions.

Streaming responses

ILlmClient now exposes both CompleteChatAsync (non-streaming) and StreamChatAsync for OpenAI-style SSE streaming. ChessCoachClient builds on StreamChatAsync to provide sentence-buffered streaming with TypingStarted/TypingEnded/SentenceReady events for Unity and other clients.

Multiple “personas”

Allow different system prompts (strict coach, friendly commentator, trash-talking rival) passed into ChessCoachClient.

Tool-calls / function-calls

SmolLM3’s chat template supports tool calling; if you want the LLM to decide when to request deeper engine analysis, you could expose a tool schema and parse tool-calls in C#.