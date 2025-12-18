using System.IO;
using System.Text.Json;

namespace GameAI.ChessCoach.Characters
{
    /// <summary>
    /// Helper for loading CharacterProfile instances from JSON files under characters/*.json.
    /// </summary>
    public static class CharacterProfileLoader
    {
        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        };

        public static CharacterProfile LoadFromFile(string path)
        {
            string json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<CharacterProfile>(json, Options);
        }
    }
}


