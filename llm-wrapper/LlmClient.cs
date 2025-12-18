using System;
using System.Collections.Generic;
using System.Net.Http;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace GameAI.ChessCoach.Llm
{
    public interface ILlmClient : IDisposable
    {
        /// <summary>
        /// Non-streaming: sends the full chat and returns the final text.
        /// </summary>
        Task<string> CompleteChatAsync(
            IList<LlmMessage> messages,
            CancellationToken cancellationToken = default);

        /// <summary>
        /// Streaming: sends the chat request with stream=true and invokes
        /// <paramref name="onDelta"/> for each text fragment received.
        /// onDelta receives raw delta content chunks (not guaranteed to align
        /// with tokens or words).
        /// </summary>
        Task StreamChatAsync(
            IList<LlmMessage> messages,
            Func<string, Task> onDelta,
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
            EnsureNotDisposed();

            if (messages == null || messages.Count == 0)
                throw new ArgumentException("Messages must not be empty.", nameof(messages));

            var request = BuildChatRequest(messages, stream: false);

            using var response = await _httpClient.SendAsync(
                                      request,
                                      HttpCompletionOption.ResponseContentRead,
                                      cancellationToken).ConfigureAwait(false);

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

        public async Task StreamChatAsync(
            IList<LlmMessage> messages,
            Func<string, Task> onDelta,
            CancellationToken cancellationToken = default)
        {
            EnsureNotDisposed();

            if (messages == null || messages.Count == 0)
                throw new ArgumentException("Messages must not be empty.", nameof(messages));

            if (onDelta == null)
                throw new ArgumentNullException(nameof(onDelta));

            var request = BuildChatRequest(messages, stream: true);

            using (var response = await _httpClient.SendAsync(
                       request,
                       HttpCompletionOption.ResponseHeadersRead,
                       cancellationToken).ConfigureAwait(false))
            {
                string contentType = response.Content.Headers.ContentType?.MediaType;
                if (!response.IsSuccessStatusCode)
                {
                    string errorBody = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    throw new LlmException(
                        "LLM streaming request failed.",
                        (int)response.StatusCode,
                        errorBody);
                }

                using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (var reader = new StreamReader(stream))
                {
                    while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
                    {
                        string line = await reader.ReadLineAsync().ConfigureAwait(false);
                        if (line == null)
                            break;
                        if (line.Length == 0)
                            continue;

                        if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                            continue;

                        string data = line.Substring("data:".Length).Trim();
                        if (data == "[DONE]")
                            break;

                        ChatCompletionChunkDto chunk;
                        try
                        {
                            chunk = JsonSerializer.Deserialize<ChatCompletionChunkDto>(data, JsonOptions);
                        }
                        catch
                        {
                            // Skip malformed chunks; caller can log if desired.
                            continue;
                        }

                        if (chunk?.choices == null || chunk.choices.Length == 0)
                            continue;

                        var delta = chunk.choices[0].delta;
                        if (delta == null || string.IsNullOrEmpty(delta.content))
                            continue;

                        await onDelta(delta.content).ConfigureAwait(false);
                    }
                }
            }
        }

        private void EnsureNotDisposed()
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(LlmClient));
        }

        private HttpRequestMessage BuildChatRequest(
            IList<LlmMessage> messages,
            bool stream)
        {
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
                stop = _config.StopSequences.Length > 0 ? _config.StopSequences : null,
                stream = stream
            };

            string json = JsonSerializer.Serialize(requestDto, JsonOptions);
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            var uri = new Uri(_config.BaseUrl + "/chat/completions");

            return new HttpRequestMessage(HttpMethod.Post, uri)
            {
                Content = content
            };
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
            public bool stream { get; set; }
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

        private sealed class ChatCompletionChunkDto
        {
            public ChunkChoiceDto[] choices { get; set; }
        }

        private sealed class ChunkChoiceDto
        {
            public ChunkDeltaDto delta { get; set; }
        }

        private sealed class ChunkDeltaDto
        {
            public string content { get; set; }
        }

        #endregion
    }
}


