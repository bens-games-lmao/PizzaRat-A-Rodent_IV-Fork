using System.Text.Json.Serialization;

namespace GameAI.ChessCoach.Characters
{
    /// <summary>
    /// Minimal C# representation of the CharacterProfile JSON described in characters/schema.json.
    /// Only the fields relevant for LLM persona building are modeled here.
    /// </summary>
    public sealed class CharacterProfile
    {
        [JsonPropertyName("id")]
        public string Id { get; set; }

        [JsonPropertyName("description")]
        public string Description { get; set; }

        [JsonPropertyName("strength")]
        public StrengthConfig Strength { get; set; }

        [JsonPropertyName("taunts")]
        public TauntConfig Taunts { get; set; }
    }

    public sealed class StrengthConfig
    {
        [JsonPropertyName("targetElo")]
        public int TargetElo { get; set; }

        [JsonPropertyName("useWeakening")]
        public bool UseWeakening { get; set; }

        [JsonPropertyName("searchSkill")]
        public int SearchSkill { get; set; }

        [JsonPropertyName("selectivity")]
        public int Selectivity { get; set; }

        [JsonPropertyName("slowMover")]
        public int SlowMover { get; set; }
    }

    public sealed class TauntConfig
    {
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; }

        [JsonPropertyName("tauntFile")]
        public string TauntFile { get; set; }

        [JsonPropertyName("intensity")]
        public int Intensity { get; set; }

        [JsonPropertyName("rudeness")]
        public int Rudeness { get; set; }

        [JsonPropertyName("whenLosing")]
        public int WhenLosing { get; set; }
    }
}


